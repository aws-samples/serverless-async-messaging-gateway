/*! Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. */
/*! SPDX-License-Identifier: MIT-0 */

import { Logger } from "@aws-lambda-powertools/logger";
import {
  DynamoDBClient,
  BatchWriteItemCommand,
  paginateQuery,
} from "@aws-sdk/client-dynamodb";
import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";

const MESSAGES_TABLE = process.env.MESSAGES_TABLE;
const MESSAGES_QUEUE_URL = process.env.MESSAGES_QUEUE_URL;

const logger = new Logger();
const dynamoDB = new DynamoDBClient();
const sqs = new SQSClient();

/**
 * The handler function for the connections stream to send the unsent messages to the messages queue.
 *
 * @param {any} event the event object.
 */
export async function handler(event) {
  for (const ddbEvent of event.Records) {
    const userId = ddbEvent.dynamodb.Keys.userId.S;
    logger.appendKeys({ userId });
    logger.info("Processing unsent messages for the user");

    const paginatorConfig = {
      client: dynamoDB,
      pageSize: 10,
    };

    // Query all messages that were not sent yet for the user.
    const command = {
      TableName: MESSAGES_TABLE,
      KeyConditionExpression: "#userId = :userId",
      ExpressionAttributeNames: {
        "#userId": "userId",
        "#timestamp": "timestamp",
      },
      ExpressionAttributeValues: {
        ":userId": { S: userId },
      },
      ProjectionExpression: "#userId,#timestamp,message",
      ScanIndexForward: true,
    };

    const paginator = paginateQuery(paginatorConfig, command);

    for await (const page of paginator) {
      logger.info("Processing page", { count: page.Count });
      if (page.Count === 0) {
        continue;
      }

      const msgCommand = new SendMessageBatchCommand({
        QueueUrl: MESSAGES_QUEUE_URL,
        Entries: page.Items.map((item, index) => ({
          Id: `${index}`,
          MessageBody: JSON.stringify({
            userId: item.userId.S,
            timestamp: parseInt(item.timestamp.N),
            message: item.message.S,
          }),
          MessageDeduplicationId: crypto.randomUUID(),
          MessageGroupId: userId,
        })),
      });

      logger.info("Sending messages to queue");
      const response = await sqs.send(msgCommand);
      logger.info("response counts", {
        Successful: response.Successful?.length ?? 0,
        Failed: response.Failed?.length ?? 0,
      });

      if (!response.Successful?.length) {
        logger.error("No messages were successfully sent to the queue");
        return {
          batchItemFailures: [
            {
              itemIdentifier: ddbEvent.dynamodb.SequenceNumber,
            },
          ],
        };
      }

      const input = {
        RequestItems: {
          [MESSAGES_TABLE]: response.Successful.map((item) => ({
            DeleteRequest: {
              Key: {
                userId: page.Items[parseInt(item.Id)].userId,
                timestamp: page.Items[parseInt(item.Id)].timestamp,
              },
            },
          })),
        },
      };

      logger.info("Removing successful messages sent from the database");
      const deleteCommand = new BatchWriteItemCommand(input);

      await dynamoDB.send(deleteCommand);

      if (response.Failed?.length > 0) {
        // Reporting the first problem to commit the stream.
        logger.error("failed to send messages to the queue", {
          Successful: response.Successful?.length ?? 0,
          Failed: response.Failed.length,
        });
        return {
          batchItemFailures: [
            {
              itemIdentifier: ddbEvent.dynamodb.SequenceNumber,
            },
          ],
        };
      }
    }
  }

  logger.info("Processing ended");
  return {
    batchItemFailures: [],
  };
}
