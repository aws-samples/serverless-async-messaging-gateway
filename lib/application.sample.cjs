/*! Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. */
/*! SPDXSPDX-License-Identifier: MIT-0 */

const { Logger } = require("@aws-lambda-powertools/logger");
const aws4 = require("aws4");
const https = require("https");

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
 * @param {any} context the context object.
 * @returns {any} the response object.
 */
async function handler(event, context) {
  logger.addContext(context);
  logger.removeKeys(["userId"]);

  const body = JSON.parse(event.body);

  if (
    body.wait === undefined ||
    body.userId === undefined ||
    body.message === undefined
  ) {
    logger.error("Missing required parameters", { body });
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

  const reqbody = JSON.stringify({ userId, message });

  const opts = {
    body: reqbody,
    headers: {
      "Content-Type": "application/json",
      host: url.host,
    },
    hostname: url.hostname,
    method: "POST",
    path: url.pathname,
  };

  aws4.sign(opts);

  const response = await new Promise((resolve, reject) => {
    let responseBody = "";

    const req = https.request(url, opts, (res) => {
      res.on("data", (chunk) => {
        responseBody += chunk;
      });
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          statusMessage: res.statusMessage,
          headers: res.headers,
          body: responseBody,
        });
      });
    });

    req.on("error", (err) => {
      logger.error("Error sending message", err);
      reject(err);
    });

    req.write(reqbody);

    req.end();
  });

  logger.info("Response status code", { statusCode: response.statusCode });
  if (Math.floor(response.statusCode / 100) !== 2) {
    logger.error("Error sending message", { response });
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
}

module.exports = { handler };
