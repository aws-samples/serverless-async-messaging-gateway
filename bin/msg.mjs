#!/usr/bin/env node
/*! Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. */
/*! SPDXSPDX-License-Identifier: MIT-0 */

import { program, Option } from "commander";
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminInitiateAuthCommand,
  AdminRespondToAuthChallengeCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import * as https from "https";
import { WebSocket } from "ws";

const OUTPUT_MAP = [
  "AuthenticationUserPoolId",
  "AuthenticationUserPoolClientId",
  "AuthenticationTokenApiUrl",
  "GatewayWebsocketUrl",
  "SampleAppApiUrl",
];

async function getStackOutputs() {
  console.warn("Getting stack outputs...");
  const client = new CloudFormationClient({ region: program.opts().region });
  const input = {
    StackName: program.opts().stack,
  };
  const command = new DescribeStacksCommand(input);
  const response = await client.send(command);

  const outputs = response.Stacks[0].Outputs;

  const maps = {};
  for (let output of outputs) {
    for (let key of OUTPUT_MAP) {
      if (output.OutputKey.startsWith(key)) {
        maps[key] = output.OutputValue;
      }
    }
  }

  return maps;
}

/*** random password generation ***/
/**
 * sets of charachters
 */
var upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
var lower = "abcdefghijklmnopqrstuvwxyz";
var digit = "0123456789";
var symbol = "@#$%&*()_-+={}[];:<>,.?/";
var all = upper + lower + digit + symbol;

/**
 * generate random integer not greater than `max`
 */

function rand(max) {
  return Math.floor(Math.random() * max);
}

/**
 * generate random character of the given `set`
 */

function random(set) {
  return set[rand(set.length - 1)];
}

/**
 * generate an array with the given `length`
 * of characters of the given `set`
 */

function generate(length, set) {
  var result = [];
  while (length--) result.push(random(set));
  return result;
}

/**
 * shuffle an array randomly
 */
function shuffle(arr) {
  var result = [];

  while (arr.length) {
    result = result.concat(arr.splice(rand[arr.length - 1]));
  }

  return result;
}
/**
 * do the job
 */
function password(length) {
  var result = []; // we need to ensure we have some characters

  result = result.concat(generate(1, upper)); // 1 upper case
  result = result.concat(generate(1, lower)); // 1 lower case
  result = result.concat(generate(1, digit)); // 1 digit
  result = result.concat(generate(1, symbol)); // 1 symbol
  result = result.concat(generate(length - 4, all)); // remaining - whatever

  return shuffle(result).join(""); // shuffle and make a string
}
/**********************************/

let OUTPUTS = undefined;

program
  .name("msg")
  .description("CLI to test the async messaging gateway.")
  .requiredOption(
    "-s, --stack <stack-name>",
    "the deployed stack name",
    "ServerlessAsyncMessagingGatewayStack",
  )
  .addOption(
    new Option("-r, --region <region>", "the AWS region")
      .env("AWS_DEFAULT_REGION")
      .makeOptionMandatory(),
  )
  .hook("preAction", async () => {
    OUTPUTS = await getStackOutputs();
  });

program
  .command("create-user")
  .description("Create a user at the Cognito user pool.")
  .copyInheritedSettings(program)
  .option("-u, --username <username>", "the username", "testUser")
  .requiredOption("-p, --password <password>", "the user's password")
  .action(async (options) => {
    const client = new CognitoIdentityProviderClient({
      region: program.opts().region,
    });
    let response = undefined;

    const randomPassword = password(16);

    console.warn(`Creating user ${options.username}...`);
    await client.send(
      new AdminCreateUserCommand({
        UserPoolId: OUTPUTS.AuthenticationUserPoolId,
        Username: options.username,
        TemporaryPassword: randomPassword,
      }),
    );

    console.warn(`Authenticating user ${options.username}...`);
    response = await client.send(
      new AdminInitiateAuthCommand({
        UserPoolId: OUTPUTS.AuthenticationUserPoolId,
        ClientId: OUTPUTS.AuthenticationUserPoolClientId,
        AuthFlow: "ADMIN_NO_SRP_AUTH",
        AuthParameters: {
          USERNAME: options.username,
          PASSWORD: randomPassword,
        },
      }),
    );
    const session = response.Session;

    console.warn(`Responding to challenge for user ${options.username}...`);
    await client.send(
      new AdminRespondToAuthChallengeCommand({
        UserPoolId: OUTPUTS.AuthenticationUserPoolId,
        ClientId: OUTPUTS.AuthenticationUserPoolClientId,
        ChallengeName: "NEW_PASSWORD_REQUIRED",
        ChallengeResponses: {
          USERNAME: options.username,
          NEW_PASSWORD: options.password,
        },
        Session: session,
      }),
    );

    console.warn(`User ${options.username} created!`);
  });

program
  .command("auth")
  .description("Authenticate a user at the Cognito user pool.")
  .addHelpText(
    "after",
    '\nRun with "eval" to export the generated token:\n  $ eval `msg auth -p passwd`',
  )
  .copyInheritedSettings(program)
  .option("-u, --username <username>", "the username", "testUser")
  .requiredOption("-p, --password <password>", "the user's password")
  .action(async (options) => {
    const client = new CognitoIdentityProviderClient({
      region: program.opts().region,
    });

    console.warn(`Authenticating user ${options.username}...`);
    const response = await client.send(
      new AdminInitiateAuthCommand({
        UserPoolId: OUTPUTS.AuthenticationUserPoolId,
        ClientId: OUTPUTS.AuthenticationUserPoolClientId,
        AuthFlow: "ADMIN_NO_SRP_AUTH",
        AuthParameters: {
          USERNAME: options.username,
          PASSWORD: options.password,
        },
      }),
    );
    const idToken = response.AuthenticationResult.IdToken;
    console.warn(`ID_TOKEN="${idToken}"`);
    console.info(`export ID_TOKEN="${idToken}"`);
  });

program
  .command("connect-websocket")
  .description("Connect to the websocket endpoint.")
  .copyInheritedSettings(program)
  .addOption(
    new Option("-t, --token <id-token>", "the ID token from Cognito")
      .env("ID_TOKEN")
      .makeOptionMandatory(),
  )
  .action(async (options) => {
    console.warn("Getting temporary token...");
    const response = await new Promise((resolve, reject) => {
      https
        .get(
          OUTPUTS.AuthenticationTokenApiUrl,
          {
            headers: {
              Authorization: options.token,
            },
          },
          (res) => {
            res.setEncoding("utf8");
            let rawData = "";
            res.on("data", (chunk) => {
              rawData += chunk;
            });
            res.on("end", () => {
              if (Math.floor(res.statusCode / 100) != 2) {
                return reject(
                  JSON.stringify({
                    statusCode: res.statusCode,
                    statusMessage: res.statusMessage,
                    body: rawData,
                  }),
                );
              }
              return resolve(JSON.parse(rawData));
            });
          },
        )
        .on("error", (err) => {
          return reject(err);
        });
    });

    console.warn("Connecting to messages websocket...");
    const ws = new WebSocket(
      `${OUTPUTS.GatewayWebsocketUrl}?token=${response.token}`,
    );
    ws.on("open", () => {
      console.warn("Connected to messages websocket...");
    });
    ws.on("message", (data) => {
      console.warn(`< ${data}`);
    });
    ws.on("error", (err) => {
      console.error(`Error: ${err.message}`);
    });
    ws.on("close", (code, reason) => {
      console.warn(`Closed: ${code} ${reason}`);
    });
  });

program
  .command("send-message")
  .description("Send a message for delivery.")
  .copyInheritedSettings(program)
  .addOption(
    new Option(
      "-w, --wait <delay>",
      "time to wait in seconds to simulate a long running task",
    )
      .default(10)
      .argParser(parseInt),
  )
  .addOption(
    new Option("-t, --token <id-token>", "the ID token from Cognito")
      .env("ID_TOKEN")
      .makeOptionMandatory(),
  )
  .argument("<string...>", "message to send")
  .action(async (args, options) => {
    const userId = JSON.parse(
      Buffer.from(options.token.split(".")[1], "base64").toString(),
    ).sub;

    console.warn(`Sending message to ${userId}...`);
    const response = await new Promise((resolve, reject) => {
      const req = https
        .request(
          OUTPUTS.SampleAppApiUrl,
          {
            method: "POST",
            headers: {
              Authorization: options.token,
              "Content-Type": "application/json",
            },
          },
          (res) => {
            res.setEncoding("utf8");
            let rawData = "";
            res.on("data", (chunk) => {
              rawData += chunk;
            });
            res.on("end", () => {
              if (Math.floor(res.statusCode / 100) != 2) {
                return reject(
                  JSON.stringify({
                    statusCode: res.statusCode,
                    statusMessage: res.statusMessage,
                    body: rawData,
                  }),
                );
              }
              return resolve({
                statusCode: res.statusCode,
                statusMessage: res.statusMessage,
                body: rawData,
              });
            });
          },
        )
        .on("error", (err) => {
          return reject(err);
        });

      req.write(
        JSON.stringify({
          wait: options.wait,
          userId: userId,
          message: args.join(" "),
        }),
      );
      req.end();
    });

    console.warn(`Message sent with statusCode ${response.statusCode}.`);
  });

program.parse();
