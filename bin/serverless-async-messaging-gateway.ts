#!/usr/bin/env node
/*! Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. */
/*! SPDXSPDX-License-Identifier: MIT-0 */

import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { ServerlessAsyncMessagingGatewayStack } from "../lib/serverless-async-messaging-gateway-stack";

const app = new cdk.App();
new ServerlessAsyncMessagingGatewayStack(
  app,
  "ServerlessAsyncMessagingGatewayStack",
);
