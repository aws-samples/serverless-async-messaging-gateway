/*! Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. */
/*! SPDX-License-Identifier: MIT-0 */

import { Logger } from "@aws-lambda-powertools/logger";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { KMSClient, EncryptCommand } from "@aws-sdk/client-kms";

const SERVICE = process.env.SERVICE;
const TOKENS_TABLE = process.env.TOKENS_TABLE;
const KEY_ID = process.env.KEY_ID;
const TOKEN_EXP_SECONDS = 30;

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
 * Encrypts a token.
 *
 * @param {any} token the token to encrypt.
 * @returns {Promise<string>} the encrypted token in URL safe BASE64.
 */
async function encrypt(token) {
  const tokenStr = JSON.stringify(token, null, 0);

  const input = {
    KeyId: KEY_ID,
    Plaintext: Buffer.from(tokenStr, "utf8"),
  };
  const command = new EncryptCommand(input);
  const response = await kms.send(command);

  const encryptedToken = Buffer.from(response.CiphertextBlob).toString(
    "base64url",
  );
  return encryptedToken;
}

/**
 * Stores the token at the database.
 *
 * @param {string} token the token to store.
 * @param {number} exp the expiration time of the token.
 */
async function store(token, exp) {
  const input = {
    TableName: TOKENS_TABLE,
    Item: {
      token: {
        S: token,
      },
      ttl: {
        N: exp.toString(),
      },
    },
  };

  const command = new PutItemCommand(input);
  await dynamoDB.send(command);
}

/**
 * The handler function.
 *
 * @param {any} event the event object.
 * @returns {any} the response object.
 */
export async function handler(event) {
  const claims = event.requestContext.authorizer.claims;

  const token = {
    iss: SERVICE,
    exp: epoch() + TOKEN_EXP_SECONDS,
    sub: claims.sub,
    aud: SERVICE,
    "cognito:username": claims["cognito:username"],
  };

  const encryptedToken = await encrypt(token);

  await store(encryptedToken, token.exp);

  logger.info("token generated", {
    sub: claims.sub,
    username: claims["cognito:username"],
  });
  return {
    statusCode: 200,
    body: JSON.stringify({
      token: encryptedToken,
    }),
  };
}
