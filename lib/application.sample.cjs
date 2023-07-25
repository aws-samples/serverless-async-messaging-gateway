/*! Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. */
/*! SPDXSPDX-License-Identifier: MIT-0 */

const aws4 = require("aws4");
const https = require("https");

const MESSAGE_API = process.env.MESSAGE_API;

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
  const body = JSON.parse(event.body);

  if (
    body.wait === undefined ||
    body.userId === undefined ||
    body.message === undefined
  ) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        message: "Missing required parameters.",
      }),
    };
  }

  const { userId, message } = body;
  const wait = Math.min(15*60, body.wait);
  const url = new URL(MESSAGE_API);

  console.log("Sleeping " + wait + " seconds to simulate some processing.");
  await sleep(wait);

  console.log("Sending message to " + userId);

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
      console.error("Error sending message: " + err);
      reject(err);
    });

    req.write(reqbody);

    req.end();
  });

  console.log("Response status code: " + response.statusCode);
  if (Math.floor(response.statusCode / 100) !== 2) {
    console.error("Error received: " + JSON.stringify(response));
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
