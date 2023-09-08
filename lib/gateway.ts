/*! Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. */
/*! SPDXSPDX-License-Identifier: MIT-0 */

import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as eventsources from "aws-cdk-lib/aws-lambda-event-sources";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as pipes from "aws-cdk-lib/aws-pipes";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { NagSuppressions } from "cdk-nag";

import * as utils from "./utils";

const MESSAGE_PATH = "message";

export interface GatewayProps {
  // The Lambda token authorizer to authorize a websocket connection
  tokenAuthorizerFn: lambda.IFunction;
}

/**
 * Creates the asynchronous messaging gateway.
 */
export class Gateway extends Construct {
  // URL to request to send a message
  public readonly messageUrl: string;

  // The ARN of the websocket authorizer
  public readonly websocketAuthorizerArn: string;

  // The send message API
  private readonly messageApi: apigateway.IRestApi;

  // The Powertools Layer
  private readonly powertoolsLayer: lambda.ILayerVersion;

  /**
   * Constructs the gateway.
   */
  constructor(scope: Construct, id: string, props: GatewayProps) {
    super(scope, id);

    this.powertoolsLayer = this.createPowertoolsLayer();

    const connectionsTable = this.createConnectionsTable();

    const messagesTable = this.createMessagesTable();

    const messagesQueue = this.createMessagesQueue();

    const apiGatewayAccount = this.createApiGatewayAccount();

    const { messagesWebsocket, stage, authorizer } =
      this.createMessagesWebsocket(
        apiGatewayAccount,
        props.tokenAuthorizerFn,
        connectionsTable,
      );

    this.websocketAuthorizerArn = `arn:${
      cdk.Stack.of(messagesWebsocket).partition
    }:execute-api:${cdk.Stack.of(messagesWebsocket).region}:${
      cdk.Stack.of(messagesWebsocket).account
    }:${messagesWebsocket.ref}/authorizers/${authorizer.ref}`;

    this.createSendMessageSfn(
      messagesQueue,
      messagesTable,
      connectionsTable,
      messagesWebsocket,
      stage.ref,
    );

    this.createSendUnsentMessagesLambda(
      messagesTable,
      messagesQueue,
      connectionsTable,
    );

    const messageApi = this.createMessageApi(apiGatewayAccount, messagesQueue);

    this.messageUrl = `${messageApi.url}message`;
    this.messageApi = messageApi;

    new cdk.CfnOutput(this, "WebsocketUrl", {
      value: `${messagesWebsocket.attrApiEndpoint}/${stage.ref}`,
    });
  }

  /**
   * Creates the Powertools Layer.
   *
   * @return the layer reference.
   */
  private createPowertoolsLayer(): lambda.ILayerVersion {
    return lambda.LayerVersion.fromLayerVersionArn(
      this,
      "PowertoolsLayer",
      `arn:aws:lambda:${
        cdk.Stack.of(this).region
      }:094274105915:layer:AWSLambdaPowertoolsTypeScript:18`,
    );
  }

  /**
   * Creates the Connections table.
   *
   * The records has the following properties:
   * - userId {PK, string}: the user ID from the Cognito User Pool.
   * - connectionId {string}: the WebSocket connection ID.
   *
   * @returns the table reference.
   */
  private createConnectionsTable(): dynamodb.ITable {
    let removalPolicy;
    if (this.node.tryGetContext("destroy-all")) {
      removalPolicy = cdk.RemovalPolicy.DESTROY;
    }

    const connectionsTable = new dynamodb.Table(this, "Connections", {
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
    });

    return connectionsTable;
  }

  /**
   * Creates the Messages table.
   *
   * The recoreds have the following properties:
   * - userId {PK, string}: the user ID from the Cognito User Pool.
   * - timestamp {SK, number}: the timestamp of the message when the gateway received it for the first time.
   * - message {string}: the message to send.
   *
   * @returns the table reference.
   */
  private createMessagesTable(): dynamodb.ITable {
    let removalPolicy;
    if (this.node.tryGetContext("destroy-all")) {
      removalPolicy = cdk.RemovalPolicy.DESTROY;
    }

    const messagesTable = new dynamodb.Table(this, "Messages", {
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "timestamp", type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
    });

    return messagesTable;
  }

  /**
   * Creates the FIFO queue with the messages to send.
   *
   * The messages have the following body:
   * - userId {string}: the user ID from the Cognito User Pool.
   * - timestamp {number}: the timestamp of the message when the gateway received it for the first time.
   * - message {string}: the message to send.
   *
   * The Message Group ID is the userId to keep the messages ordered.
   *
   * In each try, a new Message Deduplication ID is created so it can retry to send the message as soon as the client is connected.
   *
   * @returns the SQS FIFO queue reference.
   */
  private createMessagesQueue(): sqs.IQueue {
    const messagesDLQ = new sqs.Queue(this, "MessagesDeadLetterQueue", {
      fifo: true,
      enforceSSL: true,
      removalPolicy: utils.getRemovalPolicy(this.node),
    });

    const messagesQueue = new sqs.Queue(this, "MessagesQueue", {
      fifo: true,
      enforceSSL: true,
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: messagesDLQ,
      },
      removalPolicy: utils.getRemovalPolicy(this.node),
    });

    return messagesQueue;
  }

  /**
   * Creates the API Gateway Account with permission to push to CloudWatch Logs.
   *
   * @returns reference to the API Gateway account.
   */
  private createApiGatewayAccount(): apigateway.CfnAccount {
    const role = new iam.Role(this, "CloudWatchRole", {
      assumedBy: new iam.ServicePrincipal("apigateway.amazonaws.com"),
    });

    role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "service-role/AmazonAPIGatewayPushToCloudWatchLogs",
      ),
    );

    NagSuppressions.addResourceSuppressions(role, [
      {
        id: "AwsSolutions-IAM4",
        reason:
          "The API Gateway name is not known to restrict the policy resource scope.",
      },
    ]);

    const apiGatewayAccount = new apigateway.CfnAccount(this, "Account", {
      cloudWatchRoleArn: role.roleArn,
    });

    return apiGatewayAccount;
  }

  /**
   * Creates the messages websocket.
   *
   * @param apiGatewayAccount the API Gateway account.
   * @param authorizerFn the Lambda authorizer function that authorizes websocket connections.
   * @param connectionsTable the Connections table.
   * @returns details of the websocket API.
   */
  private createMessagesWebsocket(
    apiGatewayAccount: apigateway.CfnAccount,
    authorizerFn: lambda.IFunction,
    connectionsTable: dynamodb.ITable,
  ): {
    messagesWebsocket: apigatewayv2.CfnApi;
    stage: apigatewayv2.CfnStage;
    authorizer: apigatewayv2.CfnAuthorizer;
  } {
    const messagesWebsocket = new apigatewayv2.CfnApi(this, "Websocket", {
      name: "MessagesWebsocket",
      protocolType: "WEBSOCKET",
      routeSelectionExpression: "$request.body.action",
    });

    messagesWebsocket.node.addDependency(apiGatewayAccount);

    const connectionsIntegrationRole = new iam.Role(
      this,
      "ConnectionsIntegrationRole",
      {
        assumedBy: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      },
    );

    connectionsIntegrationRole.addToPolicy(
      new iam.PolicyStatement({
        resources: [connectionsTable.tableArn],
        actions: ["dynamodb:PutItem"],
      }),
    );

    // Integration with the DynamoDB to store the connection ID of the connected user.
    const connectionsIntegration = new apigatewayv2.CfnIntegration(
      this,
      "ConnectionsIntegration",
      {
        apiId: messagesWebsocket.ref,
        integrationType: "AWS",
        integrationUri: `arn:${
          cdk.Stack.of(connectionsTable).partition
        }:apigateway:${
          cdk.Stack.of(connectionsTable).region
        }:dynamodb:action/PutItem`,
        credentialsArn: connectionsIntegrationRole.roleArn,
        integrationMethod: "POST",
        passthroughBehavior: "NEVER",
        requestTemplates: {
          $default: JSON.stringify({
            Item: {
              userId: { S: "$context.authorizer.principalId" },
              connectionId: { S: "$context.connectionId" },
            },
            TableName: connectionsTable.tableName,
          }),
        },
        templateSelectionExpression: "\\$default",
      },
    );

    new apigatewayv2.CfnIntegrationResponse(
      this,
      "ConnectionsIntegrationResponse",
      {
        apiId: messagesWebsocket.ref,
        integrationId: connectionsIntegration.ref,
        integrationResponseKey: "/200/",
      },
    );

    const authorizer = new apigatewayv2.CfnAuthorizer(this, "TokenAuthorizer", {
      apiId: messagesWebsocket.ref,
      authorizerType: "REQUEST",
      name: "TokenAuthorizer",
      authorizerUri: `arn:${cdk.Stack.of(authorizerFn).partition}:apigateway:${
        cdk.Stack.of(authorizerFn).region
      }:lambda:path/2015-03-31/functions/${
        authorizerFn.functionArn
      }/invocations`,
      identitySource: ["route.request.querystring.token"],
    });

    const connectionRoute = new apigatewayv2.CfnRoute(
      this,
      "ConnectionsRoute",
      {
        apiId: messagesWebsocket.ref,
        routeKey: "$connect",
        target: `integrations/${connectionsIntegration.ref}`,
        authorizationType: "CUSTOM",
        authorizerId: authorizer.attrAuthorizerId,
      },
    );

    new apigatewayv2.CfnRouteResponse(this, "ConnectionsRouteResponse", {
      apiId: messagesWebsocket.ref,
      routeId: connectionRoute.ref,
      routeResponseKey: "$default",
    });

    const logGroup = new logs.LogGroup(this, "WebsocketAccessLogs", {
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: utils.getRemovalPolicy(this.node),
    });

    const stage = new apigatewayv2.CfnStage(this, "WebsocketStage", {
      apiId: messagesWebsocket.ref,
      stageName: "prod",
      autoDeploy: true,
      defaultRouteSettings: {
        ...utils.getApiLog(this.node),
      },
      accessLogSettings: {
        destinationArn: logGroup.logGroupArn,
        format: utils.ACCESS_LOG_FORMAT.toString(),
      },
    });

    return { messagesWebsocket, stage, authorizer };
  }

  /**
   * Create the Step Functions to send a message to the user.
   *
   * @param messagesQueue the Messages SQS queue.
   * @param messagesTable the Messages DynamoDB table.
   * @param connectionsTable the Connections DynamoDB table.
   * @param apiId the websocket API.
   * @param apiStage the websocket API stage.
   * @returns the Step Functions reference.
   */
  private createSendMessageSfn(
    messagesQueue: sqs.IQueue,
    messagesTable: dynamodb.ITable,
    connectionsTable: dynamodb.ITable,
    messagesWebsocket: apigatewayv2.CfnApi,
    apiStage: string,
  ): sfn.IStateMachine {
    const sendMessageSfnRole = new iam.Role(this, "SendMessageSfnRole", {
      assumedBy: new iam.ServicePrincipal("states.amazonaws.com"),
    });
    messagesTable.grantReadWriteData(sendMessageSfnRole);
    connectionsTable.grantReadData(sendMessageSfnRole);

    sendMessageSfnRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["execute-api:ManageConnections"],
        resources: [
          `arn:${cdk.Stack.of(messagesWebsocket).partition}:execute-api:${
            cdk.Stack.of(messagesWebsocket).region
          }:${cdk.Stack.of(messagesWebsocket).account}:${
            messagesWebsocket.attrApiId
          }/${apiStage}/POST/@connections/*`,
        ],
      }),
    );

    NagSuppressions.addResourceSuppressions(
      sendMessageSfnRole,
      [
        {
          id: "AwsSolutions-IAM5",
          reason: "The connecion ID is dynamic created during execution.",
        },
      ],
      true,
    );

    const sendMessageSfnLog = new logs.LogGroup(this, "SendMessageSfnLog", {
      retention: logs.RetentionDays.ONE_DAY,
      logGroupName: "/aws/vendedlogs/states/SendMessage",
      removalPolicy: utils.getRemovalPolicy(this.node),
    });

    sendMessageSfnLog.grantWrite(sendMessageSfnRole);

    const logsOpt = {
      destination: sendMessageSfnLog,
      level: sfn.LogLevel.ALL,
      includeExecutionData: true,
    };

    const sendMessageSfn = new sfn.StateMachine(this, "SendMessage", {
      definitionBody: sfn.DefinitionBody.fromFile("assets/SendMessage.asl"),
      definitionSubstitutions: {
        MessagesTable: messagesTable.tableName,
        ConnectionsTable: connectionsTable.tableName,
        ApiEndpoint: `${messagesWebsocket.attrApiId}.execute-api.${
          cdk.Stack.of(this).region
        }.amazonaws.com`,
        ApiStage: apiStage,
        partition: cdk.Stack.of(this).partition,
      },
      stateMachineType: sfn.StateMachineType.EXPRESS,
      role: sendMessageSfnRole,
      logs: logsOpt,
      tracingEnabled: true,
      removalPolicy: utils.getRemovalPolicy(this.node),
    });

    // EventBridge Pipe to start the Step Functions execution when a message is received at the Messages FIFO queue.

    const pipeRole = new iam.Role(this, "MessagePipeRole", {
      assumedBy: new iam.ServicePrincipal("pipes.amazonaws.com"),
    });

    new pipes.CfnPipe(this, "MessagesPipe", {
      roleArn: pipeRole.roleArn,
      source: messagesQueue.queueArn,
      target: sendMessageSfn.stateMachineArn,
      targetParameters: {
        stepFunctionStateMachineParameters: {
          invocationType: "REQUEST_RESPONSE",
        },
        inputTemplate: '{"body":<$.body>,"messageId":"<$.messageId>"}',
      },
    });

    messagesQueue.grantConsumeMessages(pipeRole);
    sendMessageSfn.grantStartSyncExecution(pipeRole);

    return sendMessageSfn;
  }

  /**
   * Create the Lambda function to send the pending messages to the SendMessage Step Function.
   *
   * @param messagesTable the Messages DynamoDB table.
   * @param messagesQueue the Messages SQS queue.
   * @param connectionsTable the Connections DynamoDB table.
   */
  private createSendUnsentMessagesLambda(
    messagesTable: dynamodb.ITable,
    messagesQueue: sqs.IQueue,
    connectionsTable: dynamodb.ITable,
  ) {
    // Lambda function to retrieve the pending messages and send to the Messages FIFO queue when a
    // new connection is made.
    const lambdaFn = new nodejs.NodejsFunction(this, "SendUnsentMessages", {
      architecture: lambda.Architecture.ARM_64,
      runtime: lambda.Runtime.NODEJS_18_X,
      timeout: cdk.Duration.seconds(30),
      layers: [this.powertoolsLayer],
      logRetention: logs.RetentionDays.ONE_DAY,
      bundling: {
        externalModules: [
          "aws-sdk",
          "@aws-sdk/*",
          "@aws-lambda-powertools/commons",
          "@aws-lambda-powertools/logger",
          "@aws-lambda-powertools/metrics",
          "@aws-lambda-powertools/tracer",
          "@aws-lambda-powertools/batch",
        ],
        format: nodejs.OutputFormat.ESM,
        target: "node18",
        minify: true,
        sourceMap: true,
      },
      environment: {
        MESSAGES_TABLE: messagesTable.tableName,
        MESSAGES_QUEUE_URL: messagesQueue.queueUrl,
        NODE_OPTIONS: "--enable-source-maps",
        POWERTOOLS_SERVICE_NAME: "send-unsent-messages",
      },
    });
    utils.applyLogRemovalPolicy(lambdaFn);

    messagesTable.grantReadWriteData(lambdaFn);
    messagesQueue.grantSendMessages(lambdaFn);

    if (lambdaFn.role !== undefined)
      NagSuppressions.addResourceSuppressions(lambdaFn.role, [
        {
          id: "AwsSolutions-IAM4",
          reason:
            "Lambda function name is not known before deployment to restrict resource scope, so the managed policy works here.",
        },
      ]);

    // Integrates with the Connections DynamoDB stream with a EventBridge pipe to start execution when a new websocket connection is made
    // const pipeRole = new iam.Role(this, "NewConnectionPipeRole", {
    //   assumedBy: new iam.ServicePrincipal("pipes.amazonaws.com"),
    // });

    if (connectionsTable.tableStreamArn === undefined) {
      throw new Error(
        "DynamoDB Streams is not enabled for the Connections table",
      );
    }

    lambdaFn.addEventSource(
      new eventsources.DynamoEventSource(connectionsTable, {
        reportBatchItemFailures: true,
        startingPosition: lambda.StartingPosition.LATEST,
        filters: [
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.or("INSERT", "MODIFY"),
          }),
        ],
      }),
    );

    NagSuppressions.addResourceSuppressionsByPath(
      cdk.Stack.of(this),
      "/ServerlessAsyncMessagingGatewayStack/Gateway/SendUnsentMessages/ServiceRole/DefaultPolicy/Resource",
      [
        {
          id: "AwsSolutions-IAM5",
          reason: "The permission to List streams can't be restricted.",
        },
      ],
    );

    // new pipes.CfnPipe(this, "NewConnectionPipe", {
    //   roleArn: pipeRole.roleArn,
    //   source: connectionsTable.tableStreamArn,
    //   target: lambdaFn.functionArn,
    //   targetParameters: {
    //     lambdaFunctionParameters: {
    //       invocationType: "REQUEST_RESPONSE",
    //     },
    //   },
    //   sourceParameters: {
    //     dynamoDbStreamParameters: {
    //       startingPosition: "LATEST",
    //     },
    //     filterCriteria: {
    //       filters: [
    //         {
    //           pattern: JSON.stringify({
    //             eventName: ["INSERT", "MODIFY"],
    //           }),
    //         },
    //       ],
    //     },
    //   },
    // });

    // pipeRole.attachInlinePolicy(
    //   new iam.Policy(this, "ReadStreamsPolicy", {
    //     statements: [
    //       new iam.PolicyStatement({
    //         actions: [
    //           "dynamodb:DescribeStream",
    //           "dynamodb:GetRecords",
    //           "dynamodb:GetShardIterator",
    //           "dynamodb:ListStreams",
    //         ],
    //         resources: [`${connectionsTable.tableArn}/stream/*`],
    //       }),
    //     ],
    //   }),
    // );

    // lambdaFn.grantInvoke(pipeRole);

    // NagSuppressions.addResourceSuppressionsByPath(
    //   cdk.Stack.of(this),
    //   "/ServerlessAsyncMessagingGatewayStack/Gateway/NewConnectionPipeRole/DefaultPolicy/Resource",
    //   [
    //     {
    //       id: "AwsSolutions-IAM5",
    //       reason:
    //         "The permission allows invoke of any Lambda function version.",
    //     },
    //   ],
    // );

    // NagSuppressions.addResourceSuppressionsByPath(
    //   cdk.Stack.of(this),
    //   "/ServerlessAsyncMessagingGatewayStack/Gateway/ReadStreamsPolicy/Resource",
    //   [
    //     {
    //       id: "AwsSolutions-IAM5",
    //       reason:
    //         "The streams are created during execution, so it is unknown during deployment.",
    //     },
    //   ],
    // );
  }

  /**
   * Create the REST API to send message.
   *
   * The API has the following resource:
   * - POST /message: to send a message.
   *
   * The payload needs to have the following properties:
   * - userId {string}: the user ID of the user to send the message to as in the Cognito User Pool.
   * - message {string}: the message to send.
   *
   * @param apiGatewayAccount the API Gateway account.
   * @param messageSfn the Step Function to send the message.
   * @returns the reference to the REST API.
   */
  private createMessageApi(
    apiGatewayAccount: apigateway.CfnAccount,
    messagesQueue: sqs.IQueue,
  ): apigateway.RestApi {
    const logGroup = new logs.LogGroup(this, "MessageApiAccessLogs", {
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: utils.getRemovalPolicy(this.node),
    });

    const deployOptions: apigateway.StageOptions = {
      ...utils.getApiLog(this.node),
      accessLogDestination: new apigateway.LogGroupLogDestination(logGroup),
      accessLogFormat: utils.ACCESS_LOG_FORMAT,
    };

    const messageApi = new apigateway.RestApi(this, "Message", {
      deploy: true,
      deployOptions,
      endpointTypes: [apigateway.EndpointType.REGIONAL],
    });

    messageApi.node.addDependency(apiGatewayAccount);

    const messageResource = messageApi.root.addResource(MESSAGE_PATH);

    const messageIntegrationRole = new iam.Role(
      this,
      "MessageIntegrationRole",
      {
        assumedBy: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      },
    );

    messagesQueue.grantSendMessages(messageIntegrationRole);

    const messageModel = messageApi.addModel("MessageModel", {
      schema: {
        type: apigateway.JsonSchemaType.OBJECT,
        properties: {
          userId: {
            type: apigateway.JsonSchemaType.STRING,
          },
          message: {
            type: apigateway.JsonSchemaType.STRING,
            maxLength: utils.getMaxMessageSize(this.node),
          },
        },
      },
    });

    // Send the received message to the Messages Queue.
    const sqsIntegration = new apigateway.AwsIntegration({
      service: "sqs",
      path: `${cdk.Stack.of(this).account}/${messagesQueue.queueName}`,
      options: {
        credentialsRole: messageIntegrationRole,
        passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
        requestParameters: {
          "integration.request.header.Content-Type":
            "'application/x-www-form-urlencoded'",
        },
        requestTemplates: {
          "application/json":
            "#set($body = $input.path('$'))\n#set($body.timestamp = $context.requestTimeEpoch)\nAction=SendMessage&MessageBody=$util.urlEncode($input.json('$'))&MessageDeduplicationId=$util.urlEncode($context.extendedRequestId)&MessageGroupId=$util.urlEncode($input.path('$.userId'))",
        },
        integrationResponses: [
          {
            statusCode: "200",
          },
          {
            statusCode: "400",
            selectionPattern: "4\\d{2}",
          },
          {
            statusCode: "500",
            selectionPattern: "5\\d{2}",
          },
        ],
      },
    });

    const postMethod = messageResource.addMethod("POST", sqsIntegration, {
      authorizationType: apigateway.AuthorizationType.IAM,
      methodResponses: [
        {
          statusCode: "200",
        },
        {
          statusCode: "400",
        },
        {
          statusCode: "500",
        },
      ],
      requestValidatorOptions: {
        validateRequestBody: true,
        validateRequestParameters: true,
      },
      requestModels: {
        "application/json": messageModel,
      },
    });

    NagSuppressions.addResourceSuppressions(postMethod, [
      {
        id: "AwsSolutions-COG4",
        reason: "The API GW POST uses IAM as the authorizer, not Cognito.",
      },
    ]);

    return messageApi;
  }

  /**
   * Grant invoke to the message API to a Lambda function.
   *
   * @param lambdaFn the Lambda function that will use the gateway to send message.
   */
  public grantInvoke(lambdaFn: lambda.IFunction): void {
    lambdaFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["execute-api:Invoke"],
        resources: [
          `arn:${cdk.Stack.of(this.messageApi).partition}:execute-api:${
            cdk.Stack.of(this.messageApi).region
          }:${cdk.Stack.of(this.messageApi).account}:${
            this.messageApi.restApiId
          }/${this.messageApi.deploymentStage.stageName}/POST/message`,
        ],
      }),
    );
  }
}
