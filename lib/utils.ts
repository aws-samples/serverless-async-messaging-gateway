/*! Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. */
/*! SPDXSPDX-License-Identifier: MIT-0 */

import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Node } from "constructs";
import { IConstruct } from "constructs";

// The format for the API Gateway access logs
export const ACCESS_LOG_FORMAT =
  apigateway.AccessLogFormat.jsonWithStandardFields();

/**
 * Gets the global Removal Policy configuration as set by the context 'destroy-all'.
 *
 * If 'destroy-all' is true, the Removal Policy will be set to DESTROY. Use this
 * configuration in testing and development environments.
 *
 * @param node the node to search for the context.
 * @returns the policy configuration or undefined if not set.
 */
export function getRemovalPolicy(node: Node): cdk.RemovalPolicy | undefined {
  return node.tryGetContext("destroy-all")
    ? cdk.RemovalPolicy.DESTROY
    : undefined;
}

/**
 * Applies the global removal policy to a Lambda function log group.
 *
 * @param lambdaFn the Lambda function to apply the policy to.
 */
export function applyLambdaLogRemovalPolicy(lambdaFn: lambda.IFunction): void {
  const removalPolicy = getRemovalPolicy(lambdaFn.node);
  if (removalPolicy) {
    lambdaFn.applyRemovalPolicy(removalPolicy);
  }
}

/**
 * Gets the maximum message size as set by the context 'max-message-size'.
 *
 * @param node the node to search for the context.
 * @returns the max message size.
 */
export function getMaxMessageSize(node: Node): number {
  return node.tryGetContext("max-message-size") as number;
}

/**
 * Returns the object to format the API Gateway logs as set by the context 'api-log-level'.
 *
 * The log level can be:
 * - ERROR: error only
 * - INFO: inforation and error
 * - FULL: inforation, error, and data details
 *
 * @param node the node to search for the context.
 * @returns the object snippet with the configuration to apply to the API Gateway stage.
 * @throws Error if the api-log-level is not set correctly.
 */
export function getApiLog(node: Node): apigateway.StageOptions {
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

// Holds the created Powertools Layers.
const POWERTOOLS_LAYERS = new Map<IConstruct, lambda.ILayerVersion>();

/**
 * Returns the Powertools Layer.
 *
 * @param construct the construct to base the format of the layer's ARN.
 * @returns the Layer version.
 */
export function getPowertoolsLayer(
  construct: IConstruct,
): lambda.ILayerVersion {
  if (POWERTOOLS_LAYERS.has(construct)) {
    const powertoolsLayer = POWERTOOLS_LAYERS.get(construct);
    if (powertoolsLayer !== undefined) return powertoolsLayer;
  }

  const powertoolsLayer = lambda.LayerVersion.fromLayerVersionArn(
    construct,
    "PowertoolsLayer",
    cdk.Stack.of(construct).formatArn({
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
      account: "094274105915",
      service: "lambda",
      resource: "layer",
      resourceName: "AWSLambdaPowertoolsTypeScript:18",
    }),
  );

  POWERTOOLS_LAYERS.set(construct, powertoolsLayer);

  return powertoolsLayer;
}
