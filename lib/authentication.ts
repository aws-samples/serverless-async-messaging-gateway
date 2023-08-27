/*! Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. */
/*! SPDXSPDX-License-Identifier: MIT-0 */

import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { NagSuppressions } from "cdk-nag";

const TOKENS_PATH = "tokens";

export interface AuthenticationProps {
  // The service name for issuer and audience of the encrypted token
  service: string;
}

/**
 * Creates the authentication component.
 */
export class Authentication extends Construct {
  // The Congnito User Pool to authenticate the users.
  public readonly userPool: cognito.IUserPool;

  // The Lambda authorizer to validate the temp token from the query string
  public readonly tokenAuthorizerFn: lambda.IFunction;

  /**
   * Constructs the authentication component.
   */
  constructor(scope: Construct, id: string, props: AuthenticationProps) {
    super(scope, id);

    const { userPool, client } = this.createCognitoUserPool();
    this.userPool = userPool;

    const tokensTable = this.createTempTokensTable();

    const kms = this.createKms();

    const generator = this.createTokenGeneratorLambda(
      props.service,
      tokensTable,
      kms,
    );

    const api = this.createGetTokenApi(generator, this.userPool);

    this.tokenAuthorizerFn = this.createTokenAuthorizerLambda(
      props.service,
      tokensTable,
      kms,
    );

    new cdk.CfnOutput(this, "UserPoolId", { value: userPool.userPoolId }); // eslint-disable-line no-new
    new cdk.CfnOutput(this, "UserPoolClientId", {
      value: client.userPoolClientId,
    }); // eslint-disable-line no-new
    new cdk.CfnOutput(this, "TokenApiUrl", {
      value: api.urlForPath("/" + TOKENS_PATH),
    }); // eslint-disable-line no-new
  }

  /**
   * Creates the Cognito User Pool.
   *
   * @returns the User Pool and the User Pool Client.
   */
  private createCognitoUserPool(): {
    userPool: cognito.IUserPool;
    client: cognito.IUserPoolClient;
  } {
    let removalPolicy = undefined;
    if (this.node.tryGetContext("destroy-all")) {
      removalPolicy = cdk.RemovalPolicy.DESTROY;
    }
    const userPool = new cognito.UserPool(this, "UserPool", {
      signInCaseSensitive: false,
      selfSignUpEnabled: true,
      signInAliases: {
        username: true,
        email: false,
        phone: false,
      },
      autoVerify: {
        email: true,
      },
      accountRecovery: cognito.AccountRecovery.NONE,
      passwordPolicy: {
        minLength: 8,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      removalPolicy,
    });

    NagSuppressions.addResourceSuppressions(userPool, [
      {
        id: "AwsSolutions-COG3",
        reason: "Additional pricing applies for Amazon Cognito advanced security features and it isn't needed for this demo. It should be considered for production.",
      }
    ]);

    const client = userPool.addClient("Client", {
      authFlows: {
        adminUserPassword: true,
        custom: true,
        userSrp: true,
        userPassword: true,
      },
    });

    return { userPool, client };
  }

  /**
   * Creates the temporary token table.
   *
   * @returns a reference to the DynamoDB table.
   */
  private createTempTokensTable(): dynamodb.ITable {
    let removalPolicy;
    if (this.node.tryGetContext("destroy-all")) {
      removalPolicy = cdk.RemovalPolicy.DESTROY;
    }

    const table = new dynamodb.Table(this, "TempTokens", {
      partitionKey: {
        name: "token",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy,
    });

    return table;
  }

  /**
   * Creates a KMS key to encrypt the generated tokens.
   *
   * @returns the reference to the KMS key.
   */
  private createKms(): kms.IKey {
    const key = new kms.Key(this, "Key", {
      enableKeyRotation: true,
      keySpec: kms.KeySpec.SYMMETRIC_DEFAULT,
      keyUsage: kms.KeyUsage.ENCRYPT_DECRYPT,
    });

    return key;
  }

  /**
   * Creates the token generator Lambda function.
   *
   * @param service the service name for issuer and audience of the encrypted token.
   * @param tokensTable the DynamoDB table to store the generated token.
   * @param kms the key to encrypt the generated token.
   * @returns a reference to the Lambda function.
   */
  private createTokenGeneratorLambda(
    service: string,
    tokensTable: dynamodb.ITable,
    kms: kms.IKey,
  ): lambda.IFunction {

    const lambdaFn = new nodejs.NodejsFunction(this, "Generator", {
      architecture: lambda.Architecture.ARM_64,
      runtime: lambda.Runtime.NODEJS_18_X,
      bundling: {
        externalModules: ["aws-sdk", "@aws-sdk/*"],
        format: nodejs.OutputFormat.ESM,
        target: "node18",
        minify: true,
        sourceMap: true,
      },
      environment: {
        TOKENS_TABLE: tokensTable.tableName,
        KEY_ID: kms.keyId,
        SERVICE: service,
        NODE_OPTIONS: "--enable-source-maps",
      },
    });

    lambdaFn.role?.attachInlinePolicy(
      new iam.Policy(this, "ExecutionPolicy", {
        statements: [
          new iam.PolicyStatement({
            actions: ["kms:Encrypt"],
            resources: [kms.keyArn],
          })
        ]
      })
    );

    NagSuppressions.addResourceSuppressions(lambdaFn.role!, [
      {
        id: "AwsSolutions-IAM4",
        reason: "Lambda function name is not known before deployment to restrict resource scope, so the managed policy works here.",
      }
    ]);

    tokensTable.grantWriteData(lambdaFn);

    return lambdaFn;
  }

  /**
   * Creates the API to request the temporary token.
   *
   * @param lambdaFn the Lambda function that generates the token.
   * @param userPool the Cognito User Pool to authenticate the user.
   * @returns reference to the REST API.
   */
  private createGetTokenApi(
    lambdaFn: lambda.IFunction,
    userPool: cognito.IUserPool,
  ): apigateway.RestApi {
    const auth = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      "CognitoAuthorizer",
      {
        cognitoUserPools: [userPool],
      },
    );

    const logGroup = new logs.LogGroup(this, "ApiGatewayAccessLogs");

    const api = new apigateway.LambdaRestApi(this, "GetToken", {
      handler: lambdaFn,
      proxy: false,
      defaultMethodOptions: {
        authorizationType: apigateway.AuthorizationType.COGNITO,
        authorizer: auth,
      },
      deploy: true,
      deployOptions: {
        accessLogDestination: new apigateway.LogGroupLogDestination(logGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
        loggingLevel: apigateway.MethodLoggingLevel.ERROR,
      }
    });

    const tokens = api.root.addResource(TOKENS_PATH);
    tokens.addMethod("GET", undefined, {
      requestValidatorOptions: {
        validateRequestParameters: true,
        validateRequestBody: true,
      }
    });

    return api;
  }

  /**
   * Creates the Lambda authorizer function to validate the temp token.
   *
   * @param service the name of the service to validate the issuer and audience of the encrypted token.
   * @param tokensTable the DynamoDB table that stores the token.
   * @param kms the key to decrypt the token.
   * @returns the referenve to the Lambda function.
   */
  private createTokenAuthorizerLambda(
    service: string,
    tokensTable: dynamodb.ITable,
    kms: kms.IKey,
  ): lambda.IFunction {

    const lambdaFn = new nodejs.NodejsFunction(this, "Authorizer", {
      architecture: lambda.Architecture.ARM_64,
      runtime: lambda.Runtime.NODEJS_18_X,
      bundling: {
        externalModules: ["aws-sdk", "@aws-sdk/*"],
        format: nodejs.OutputFormat.ESM,
        target: "node18",
        minify: true,
        sourceMap: true,
      },
      environment: {
        TOKENS_TABLE: tokensTable.tableName,
        KEY_ID: kms.keyId,
        SERVICE: service,
        NODE_OPTIONS: "--enable-source-maps",
      },
    });

    NagSuppressions.addResourceSuppressions(lambdaFn.role!, [
      {
        id: "AwsSolutions-IAM4",
        reason: "Lambda function name is not known before deployment to restrict resource scope.",
      }
    ]);

    // lambdaFn.role?.attachInlinePolicy(
    //   new iam.Policy(this, "ExecutionPolicy", {
    //     statements: [
    //       // new iam.PolicyStatement({
    //       //   actions: ["kms:Encrypt"],
    //       //   resources: [kms.keyArn],
    //       // })
    //     ]
    //   })
    // );

    // NagSuppressions.addResourceSuppressionsByPath(cdk.Stack.of(this), "/ServerlessAsyncMessagingGatewayStack/Authentication/ExecutionPolicy/Resource", [
    //   {
    //     id: "AwsSolutions-IAM5",
    //     reason: "Lambda function name is not known before deployment.",
    //   }
    // ]);

    kms.grantDecrypt(lambdaFn);
    tokensTable.grantWriteData(lambdaFn);

    return lambdaFn;
  }

  /**
   * Add permission to a resource to invoke the Lambda authorizer.
   *
   * @param principal the principal to add permission to.
   * @param sourceArn the source ARN to add permission to.
   */
  addAuthorizerInvokePermission(
    principal: iam.IPrincipal,
    sourceArn: string,
  ): void {
    this.tokenAuthorizerFn.addPermission(`InvokePermission`, {
      principal,
      action: "lambda:InvokeFunction",
      sourceArn,
    });
  }
}
