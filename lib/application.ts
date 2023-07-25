/*! Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. */
/*! SPDXSPDX-License-Identifier: MIT-0 */

import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import type * as cognito from "aws-cdk-lib/aws-cognito";
import { Construct } from "constructs";

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
      // eslint-disable-line no-new
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
    const sampleHandler = new nodejs.NodejsFunction(this, "sample", {
      runtime: lambda.Runtime.NODEJS_18_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(15),
      bundling: {
        externalModules: ["aws-sdk", "@aws-sdk/*"],
        format: nodejs.OutputFormat.CJS,
        target: "node18",
        minify: true,
        sourceMap: true,
      },
      environment: {
        MESSAGE_API: messageUrl,
        NODE_OPTIONS: "--enable-source-maps",
      },
    });

    return sampleHandler;
  }

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

    const api = new apigateway.RestApi(this, "Process", {
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      deploy: true,
    });

    const process = api.root.addResource(PROCESS_PATH);

    // Not using proxy to be able to do asynchronous calls.
    process.addMethod(
      "POST",
      new apigateway.LambdaIntegration(appFn, {
        proxy: false,
        requestTemplates: {
          "application/json": `{"body": "$util.escapeJavaScript($input.json('$'))"}`,
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
      }),
      {
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
      },
    );

    return api;
  }
}
