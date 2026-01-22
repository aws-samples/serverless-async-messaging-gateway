/*! Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. */
/*! SPDX-License-Identifier: MIT-0 */

import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import type * as cognito from "aws-cdk-lib/aws-cognito";
import { Construct } from "constructs";
import { NagSuppressions } from "cdk-nag";

import * as utils from "./utils";

const PROCESS_PATH = "process";

export interface ApplicationProps {
  // The message URL to send the message.
  messageUrl: string;

  // The Cognito User Pool to authenticate the users.
  userPool: cognito.IUserPool;
}

/**
 * Creates a sample application to test the async message gateway.
 */
export class Application extends Construct {
  // The Lambda function to simulate an application.
  public readonly lambdaFn: lambda.IFunction;

  /**
   * Constructs the sample application
   */
  constructor(scope: Construct, id: string, props: ApplicationProps) {
    super(scope, id);

    this.lambdaFn = this.createApp(props.messageUrl);
    const restApi = this.createRestApi(this.lambdaFn, props.userPool);

    new cdk.CfnOutput(this, "ApiUrl", {
      value: restApi.urlForPath("/" + PROCESS_PATH),
    });
  }

  /**
   * Creates the Lambda function to simulate the app.
   *
   * @param messageUrl full URL to send the message.
   * @returns the created Lambda function.
   */
  private createApp(messageUrl: string): lambda.IFunction {
    const role = new iam.Role(this, "sampleRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        resources: ["*"],
      }),
    );

    NagSuppressions.addResourceSuppressions(
      role,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "The Lambda function name is not known before deployment, so wildcard is used.",
        },
      ],
      true,
    );

    const sampleHandler = new nodejs.NodejsFunction(this, "sample", {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(15),
      role: role,
      layers: [utils.getPowertoolsLayer(this)],
      logRetention: logs.RetentionDays.ONE_DAY,
      bundling: {
        externalModules: [
          "@aws-sdk/*",
          "@aws-lambda-powertools/commons",
          "@aws-lambda-powertools/logger",
          "@aws-lambda-powertools/metrics",
          "@aws-lambda-powertools/tracer",
        ],
        format: nodejs.OutputFormat.ESM,
        target: "node24",
        minify: true,
        sourceMap: true,
      },
      environment: {
        MESSAGE_API: messageUrl,
        NODE_OPTIONS: "--enable-source-maps",
        POWERTOOLS_SERVICE_NAME: "sampleapp",
      },
    });
    utils.applyLambdaLogRemovalPolicy(sampleHandler);

    return sampleHandler;
  }

  /**
   * Create the REST API for the sample application.
   *
   * @param appFn the Lambda function of the sample application.
   * @param userPool the Cognito User Pool for user authorization.
   * @returns the created API Gateway REST API.
   *
   * @remarks
   * The API Gateway REST API is created with the following resources:
   * - /process: a POST endpoint to send the message. The message is processed asynchronously, so the client doesn't need to wait for the return.
   *
   * The payload needs to have the following properties:
   * - userId {string}: the user ID from the Cognito User Pool.
   * - message {string}: the message to send.
   * - wait {number}: the number of seconds to wait before sending the message.
   */
  private createRestApi(
    appFn: lambda.IFunction,
    userPool: cognito.IUserPool,
  ): apigateway.RestApi {
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      "Authorizer",
      {
        cognitoUserPools: [userPool],
      },
    );

    const logGroup = new logs.LogGroup(this, "SampleAppAccessLogs", {
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: utils.getRemovalPolicy(this.node),
    });

    const api = new apigateway.RestApi(this, "Process", {
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      deploy: true,
      deployOptions: {
        ...utils.getApiLog(this.node),
        accessLogDestination: new apigateway.LogGroupLogDestination(logGroup),
        accessLogFormat: utils.ACCESS_LOG_FORMAT,
      },
    });

    const processModel = api.addModel("RequestModel", {
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
          wait: {
            type: apigateway.JsonSchemaType.NUMBER,
          },
        },
      },
    });

    const process = api.root.addResource(PROCESS_PATH);

    // The Lambda Integration for the API Gateway
    const lambdaIntegration = new apigateway.LambdaIntegration(appFn, {
      proxy: false,
      requestTemplates: {
        "application/json":
          '{"body": "$util.escapeJavaScript($input.json(\'$\'))"}',
      },
      requestParameters: {
        "integration.request.header.X-Amz-Invocation-Type": "'Event'",
      },
      integrationResponses: [
        {
          statusCode: "202",
        },
        {
          statusCode: "500",
          selectionPattern: ".*Error sending message.*",
        },
        {
          statusCode: "400",
          selectionPattern: ".*Missing required parameters.*",
        },
      ],
      passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
    });

    // Not using proxy to be able to do asynchronous calls.
    process.addMethod("POST", lambdaIntegration, {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer,
      methodResponses: [
        {
          statusCode: "202",
        },
        {
          statusCode: "500",
        },
        {
          statusCode: "400",
        },
      ],
      requestValidatorOptions: {
        validateRequestBody: true,
        validateRequestParameters: true,
      },
      requestModels: {
        "application/json": processModel,
      },
    });

    return api;
  }
}
