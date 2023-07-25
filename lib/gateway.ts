/*! Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. */
/*! SPDXSPDX-License-Identifier: MIT-0 */

import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as pipes from "aws-cdk-lib/aws-pipes";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

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

  // The ARN of thw websocket authorizer
  public readonly websocketAuthorizerArn: string;

  // The send message API
  private readonly messageApi: apigateway.IRestApi;

  /**
   * Constructs the gateway.
   */
  constructor(scope: Construct, id: string, props: GatewayProps) {
    super(scope, id);

    const connectionsTable = this.createConnectionsTable();

    const messagesTable = this.createMessagesTable();

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

    const sendMessagesSfn = this.createSendMessageSfn(
      messagesTable,
      connectionsTable,
      messagesWebsocket,
      stage.ref,
    );

    const sendUnsentMessagesSfn = this.createSendUnsentMessagesSfn(
      messagesTable,
      connectionsTable,
      sendMessagesSfn,
    );

    const messageApi = this.createMessageApi(
      apiGatewayAccount,
      sendMessagesSfn,
    );

    this.messageUrl = `${messageApi.url}message`;
    this.messageApi = messageApi;

    // eslint-disable-next-line no-new
    new cdk.CfnOutput(this, "WebsocketUrl", {
      value: `${messagesWebsocket.attrApiEndpoint}/${stage.ref}`,
    });
  }

  /**
   * Creates the Connections table.
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
   * @returns the table reference.
   */
  private createMessagesTable(): dynamodb.ITable {
    let removalPolicy;
    if (this.node.tryGetContext("destroy-all")) {
      removalPolicy = cdk.RemovalPolicy.DESTROY;
    }

    const messagesTable = new dynamodb.Table(this, "Messages", {
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "timestamp", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
    });

    return messagesTable;
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

    // eslint-disable-next-line no-new
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

    // eslint-disable-next-line no-new
    new apigatewayv2.CfnRouteResponse(this, "ConnectionsRouteResponse", {
      apiId: messagesWebsocket.ref,
      routeId: connectionRoute.ref,
      routeResponseKey: "$default",
    });

    let defaultRouteSettings = undefined;
    if (this.node.tryGetContext("enable-apigateway-logs")) {
      defaultRouteSettings = {
        loggingLevel: "INFO",
        dataTraceEnabled: true,
      };
    }

    const stage = new apigatewayv2.CfnStage(this, "WebsocketStage", {
      apiId: messagesWebsocket.ref,
      stageName: "prod",
      autoDeploy: true,
      defaultRouteSettings,
    });

    return { messagesWebsocket, stage, authorizer };
  }

  /**
   * Creates the Step Functions to send the unsent messages.
   *
   * @param messagesTable the Messages DynamoDB table.
   * @param connectionsTable the Connections DynamoDB table.
   * @param messageSfn the Message Step Functions.
   * @returns the reference to the Step Functions.
   */
  private createSendUnsentMessagesSfn(
    messagesTable: dynamodb.ITable,
    connectionsTable: dynamodb.ITable,
    messageSfn: sfn.IStateMachine,
  ): sfn.IStateMachine {
    if (connectionsTable.tableStreamArn === undefined) {
      throw new Error("Connections table does not have a stream");
    }

    const sendUnsentMessagesSfnRole = new iam.Role(
      this,
      "SendUnsentMessagesSfnRole",
      {
        assumedBy: new iam.ServicePrincipal("states.amazonaws.com"),
      },
    );
    messagesTable.grantReadWriteData(sendUnsentMessagesSfnRole);
    messageSfn.grantStartExecution(sendUnsentMessagesSfnRole);

    let logsOpt = undefined;
    if (this.node.tryGetContext("enable-stepfunctions-logs")) {
      const sendUnsentMessagesSfnLog = new logs.LogGroup(
        this,
        "SendUnsentMessagesSfnLog",
        {
          retention: logs.RetentionDays.ONE_DAY,
        },
      );

      sendUnsentMessagesSfnLog.grantWrite(sendUnsentMessagesSfnRole);

      logsOpt = {
        destination: sendUnsentMessagesSfnLog,
        level: sfn.LogLevel.ALL,
        includeExecutionData: true,
      };
    }

    // TODO: set limit of records
    const sendUnsentMessagesSfn = new sfn.StateMachine(
      this,
      "SendUnsentMessages",
      {
        definitionBody: sfn.DefinitionBody.fromFile(
          "assets/SendUnsentMessages.asl",
        ),
        definitionSubstitutions: {
          MessagesTable: messagesTable.tableName,
          MessageSfnArn: messageSfn.stateMachineArn,
          partition: cdk.Stack.of(this).partition,
        },
        stateMachineType: sfn.StateMachineType.EXPRESS,
        role: sendUnsentMessagesSfnRole,
        logs: logsOpt,
      },
    );

    // Integrates with the Connections DynamoDB stream with a EventBridge pipe to start execution when a new websocket connection is made
    const pipeRole = new iam.Role(this, "NewConnectionPipeRole", {
      assumedBy: new iam.ServicePrincipal("pipes.amazonaws.com"),
    });

    // FIX: add dynamodb filter to only when changing or adding the connectionId: check if it is not DELETE?s
    // eslint-disable-next-line no-new
    new pipes.CfnPipe(this, "NewConnectionPipe", {
      roleArn: pipeRole.roleArn,
      source: connectionsTable.tableStreamArn,
      target: sendUnsentMessagesSfn.stateMachineArn,
      targetParameters: {
        stepFunctionStateMachineParameters: {
          invocationType: "FIRE_AND_FORGET",
        },
      },
      sourceParameters: {
        dynamoDbStreamParameters: {
          startingPosition: "LATEST",
        },
      },
    });

    connectionsTable.grantStreamRead(pipeRole);
    sendUnsentMessagesSfn.grantStartExecution(pipeRole);

    return sendUnsentMessagesSfn;
  }

  /**
   * Create the Step Functions to send a message to the user.
   *
   * @param messagesTable the Messages DynamoDB table.
   * @param connectionsTable the Connections DynamoDB table.
   * @param apiId the websocket API.
   * @param apiStage the websocket API stage.
   * @returns the Step Functions reference.
   */
  private createSendMessageSfn(
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

    let logsOpt = undefined;
    if (this.node.tryGetContext("enable-stepfunctions-logs")) {
      const sendMessageSfnLog = new logs.LogGroup(this, "SendMessageSfnLog", {
        retention: logs.RetentionDays.ONE_DAY,
      });

      sendMessageSfnLog.grantWrite(sendMessageSfnRole);

      logsOpt = {
        destination: sendMessageSfnLog,
        level: sfn.LogLevel.ALL,
        includeExecutionData: true,
      };
    }

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
    });

    return sendMessageSfn;
  }

  /**
   * Create the REST API to send message.
   *
   * @param apiGatewayAccount the API Gateway account.
   * @param messageSfn the Step Function to send the message.
   * @returns the reference to the REST API.
   */
  private createMessageApi(
    apiGatewayAccount: apigateway.CfnAccount,
    messageSfn: sfn.IStateMachine,
  ): apigateway.RestApi {
    let deployOptions;
    if (this.node.tryGetContext("enable-apigateway-logs")) {
      deployOptions = {
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
      };
    }

    const messageApi = new apigateway.RestApi(this, "Message", {
      deploy: true,
      deployOptions,
      endpointTypes: [apigateway.EndpointType.REGIONAL],
    });

    messageApi.node.addDependency(apiGatewayAccount);

    const messageResource = messageApi.root.addResource("message");

    const messageIntegrationRole = new iam.Role(
      this,
      "MessageIntegrationRole",
      {
        assumedBy: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      },
    );

    messageIntegrationRole.addToPolicy(
      new iam.PolicyStatement({
        resources: [messageSfn.stateMachineArn],
        actions: ["states:StartExecution"],
      }),
    );

    messageResource.addMethod(
      "POST",
      new apigateway.AwsIntegration({
        service: "states",
        action: "StartExecution",
        options: {
          credentialsRole: messageIntegrationRole,
          passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
          requestTemplates: {
            "application/json": `{\n  "input": "{\\\"body\\\":$util.escapeJavaScript($input.json(\'$\'))}",\n  "stateMachineArn": "${messageSfn.stateMachineArn}"\n}`,
          },
          integrationResponses: [
            {
              statusCode: "200",
            },
          ],
        },
      }),
      {
        authorizationType: apigateway.AuthorizationType.IAM,
        methodResponses: [
          {
            statusCode: "200",
          },
        ],
      },
    );

    return messageApi;
  }

  /**
   * Grant invoke to the message API to a Lambda function.
   *
   * @param lambdaFn the Lambda function that will use the gateway to send message.
   */
  grantInvoke(lambdaFn: lambda.IFunction): void {
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
