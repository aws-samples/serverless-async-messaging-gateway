/*! Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. */
/*! SPDXSPDX-License-Identifier: MIT-0 */

import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Node } from "constructs";

export const ACCESS_LOG_FORMAT =
  apigateway.AccessLogFormat.jsonWithStandardFields();

export function getRemovalPolicy(node: Node) {
  return node.tryGetContext("destroy-all")
    ? cdk.RemovalPolicy.DESTROY
    : undefined;
}

export function applyLogRemovalPolicy(lambdaFn: lambda.IFunction) {
  const removalPolicy = getRemovalPolicy(lambdaFn.node);
  if (removalPolicy) {
    lambdaFn.applyRemovalPolicy(removalPolicy);
  }
}

export function getMaxMessageSize(node: Node) {
  return node.tryGetContext("max-message-size") as number;
}

export function getApiLog(node: Node) {
  const logLevel: unknown = node.tryGetContext("api-log-level");

  switch (logLevel) {
    case undefined:
      return {};
    case "ERROR":
      return {
        loggingLevel: apigateway.MethodLoggingLevel.ERROR,
      };
    case "INFO":
      return {
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
      };
    case "FULL":
      return {
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
      };
    default:
      throw new Error(`Unknown API log level: ${logLevel as string}`);
  }
}
