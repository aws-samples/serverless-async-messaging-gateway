/*! Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. */
/*! SPDXSPDX-License-Identifier: MIT-0 */

import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { Authentication } from "./authentication";
import { Gateway } from "./gateway";
import { Application } from "./application";

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
  }
}
