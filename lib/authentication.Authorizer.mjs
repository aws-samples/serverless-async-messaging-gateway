/*! Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. */
/*! SPDXSPDX-License-Identifier: MIT-0 */

import { Logger } from "@aws-lambda-powertools/logger";
import { DynamoDBClient, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { KMSClient, DecryptCommand } from "@aws-sdk/client-kms";

const MAX_CLOCK_DRIFT_SECONDS = 5;

const SERVICE = process.env.SERVICE;
const TOKENS_TABLE = process.env.TOKENS_TABLE;
const KEY_ID = process.env.KEY_ID;

const logger = new Logger();
const kms = new KMSClient();
const dynamoDB = new DynamoDBClient();

/**
 * Gets the time since epoch.
 *
 * @returns {number} the time in seconds since epoch.
 */
function epoch() {
  const now = new Date();
  const utcMilllisecondsSinceEpoch =
    now.getTime() + now.getTimezoneOffset() * 60 * 1000;
  const utcSecondsSinceEpoch = Math.round(utcMilllisecondsSinceEpoch / 1000);
  return utcSecondsSinceEpoch;
}

/**
 * Descrypts a received token.
 *
 * @param {string} msg the token in BASE64.
 * @returns {Promise<any>} the token in JSON format.
 */
async function decrypt(msg) {
  const input = {
    KeyId: KEY_ID,
    CiphertextBlob: Buffer.from(msg, "base64url"),
  };
  const command = new DecryptCommand(input);
  const response = await kms.send(command);

  const tokenStr = Buffer.from(response.Plaintext).toString();
  return JSON.parse(tokenStr);
}

/**
 * Removes a token from the table.
 *
 * @param {string} token the encrypted token in BASE64 to remove.
 * @returns {Promise<boolean>} true if the token was removed, or false if the token didn't exist at the table.
 */
async function removeFromTable(token) {
  const input = {
    TableName: TOKENS_TABLE,
    Key: {
      token: {
        S: token,
      },
    },
    ReturnValues: "ALL_OLD",
  };
  const command = new DeleteItemCommand(input);
  const response = await dynamoDB.send(command);

  if (response.Attributes?.token?.S !== token) {
    return false;
  }

  return true;
}

/**
 * The Lambda function handler.
 *
 * @param {any} event the event object.
 * @returns {any} the response object.
 * @throws {Error} if the user is not authorized.
 */
export async function handler(event) {
  const encryptedToken = event.queryStringParameters.token;

  if (!(await removeFromTable(encryptedToken))) {
    logger.error("Token not found");
    throw new Error("Unauthorized");
  }

  const token = await decrypt(encryptedToken);

  const time = epoch();
  if (
    token.iss !== SERVICE ||
    token.exp + MAX_CLOCK_DRIFT_SECONDS <= time ||
    token.aud !== SERVICE
  ) {
    console.error("Unauthorized due an invalid property", {
      iss: token.iss,
      aud: token.aud,
      exp: token.exp,
      epoch: time,
    });
    throw new Error("Unauthorized");
  }

  console.info("principal authorized", {
    principalId: token.sub,
    username: token["cognito:username"],
    resource: event.methodArn,
  });
  return {
    principalId: token.sub,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: "execute-api:Invoke",
          Resource: event.methodArn,
        },
      ],
    },
    context: {
      username: token["cognito:username"],
    },
  };
}
