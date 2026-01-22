/*! Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. */
/*! SPDX-License-Identifier: MIT-0 */

const { Logger } = require("@aws-lambda-powertools/logger");
const aws4 = require("aws4");

const MESSAGE_API = process.env.MESSAGE_API;

const logger = new Logger();

/**
 * Sleep for wait seconds.
 * @param {number} wait time to wait in seconds.
 * @returns {Promise<void>}
 */
async function sleep(wait) {
  return new Promise((resolve) => setTimeout(resolve, wait * 1000));
}

/**
 * Event handler.
 *
 * @param {any} event the event object.
 * @returns {any} the response object.
 */
async function handler(event) {
  logger.removeKeys(["userId"]);

  const body = JSON.parse(event.body);

  if (
    body.wait === undefined ||
    body.userId === undefined ||
    body.message === undefined
  ) {
    logger.error("Missing required parameters", {
      "body.wait": body.wait ? "ok" : "missing",
      "body.userId": body.userId ? "ok" : "missing",
      "body.message": body.message ? "ok" : "missing",
    });
    return {
      statusCode: 400,
      body: JSON.stringify({
        message: "Missing required parameters.",
      }),
    };
  }

  const { userId, message } = body;
  const wait = Math.min(15 * 60, body.wait);
  const url = new URL(MESSAGE_API);

  logger.appendKeys({ userId });

  logger.info("Sleeping to simulate some processing", { wait_seconds: wait });
  await sleep(wait);

  logger.info("Sending message to the user");

  const reqBody = JSON.stringify({ userId, message });

  // Sign the request with AWS SigV4
  const signedRequest = aws4.sign({
    host: url.host,
    path: url.pathname,
    method: "POST",
    body: reqBody,
    headers: {
      "Content-Type": "application/json",
    },
  });

  try {
    const response = await fetch(MESSAGE_API, {
      method: "POST",
      headers: signedRequest.headers,
      body: reqBody,
    });

    logger.info("Response status code", { statusCode: response.status });

    if (!response.ok) {
      const responseBody = await response.text();
      logger.error("Error sending message", {
        statusCode: response.status,
        body: responseBody,
      });
      return {
        statusCode: 500,
        body: JSON.stringify({
          message: "Error sending message.",
        }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `Sent message to ${userId} after ${wait} seconds.`,
      }),
    };
  } catch (err) {
    logger.error("Error sending message", { error: err.message });
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Error sending message.",
      }),
    };
  }
}

module.exports = { handler };
