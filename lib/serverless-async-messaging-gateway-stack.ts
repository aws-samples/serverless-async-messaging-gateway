/*! Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. */
/*! SPDX-License-Identifier: MIT-0 */

import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

import { Authentication } from "./authentication";
import { Gateway } from "./gateway";
import { Application } from "./application";
import { NagSuppressions } from "cdk-nag";

export class ServerlessAsyncMessagingGatewayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const authentication = new Authentication(this, "Authentication", {
      service: "auth",
    });

    const gateway = new Gateway(this, "Gateway", {
      tokenAuthorizerFn: authentication.tokenAuthorizerFn,
    });

    authentication.addAuthorizerInvokePermission(
      new iam.ServicePrincipal("apigateway.amazonaws.com"),
      gateway.websocketAuthorizerArn,
    );

    const app = new Application(this, "SampleApp", {
      messageUrl: gateway.messageUrl,
      userPool: authentication.userPool,
    });

    gateway.grantInvoke(app.lambdaFn);

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      "/ServerlessAsyncMessagingGatewayStack/LogRetentionaae0aa3c5b4d4f87b02d85b201efdd8a",
      [
        {
          id: "AwsSolutions-IAM4",
          reason:
            "This Lambda function is used during deployment to change the Log Retention period. The managed policy is sufficient.",
        },
        {
          id: "AwsSolutions-IAM5",
          reason:
            "This Lambda function is used during deployment to change the Log Retention period. Wildcard is used in the policies as the resources name are unknwon during deployment.",
        },
      ],
      true,
    );
  }
}
