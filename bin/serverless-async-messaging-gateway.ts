#!/usr/bin/env node
/*! Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. */
/*! SPDXSPDX-License-Identifier: MIT-0 */

import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { ServerlessAsyncMessagingGatewayStack } from "../lib/serverless-async-messaging-gateway-stack";

const app = new cdk.App();
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
const stack = new ServerlessAsyncMessagingGatewayStack(
  app,
  "ServerlessAsyncMessagingGatewayStack",
);
stack.templateOptions.templateFormatVersion = "2010-09-09";
