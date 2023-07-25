{
  "Comment": "A description of my state machine",
  "StartAt": "Format input",
  "States": {
    "Format input": {
      "Type": "Pass",
      "Next": "List messages",
      "Parameters": {
        "userId.$": "$[0].dynamodb.Keys.userId.S",
        "result": {
          "LastEvaluatedKey": null
        }
      },
      "ResultPath": "$"
    },
    "List messages": {
      "Type": "Task",
      "Parameters": {
        "TableName": "${MessagesTable}",
        "ExclusiveStartKey.$": "$.result.LastEvaluatedKey",
        "KeyConditionExpression": "#userId = :userId",
        "ExpressionAttributeNames": {
          "#userId": "userId",
          "#timestamp": "timestamp"
        },
        "ExpressionAttributeValues": {
          ":userId": {
            "S.$": "$.userId"
          }
        },
        "ProjectionExpression": "#userId,#timestamp,message"
      },
      "Resource": "arn:${partition}:states:::aws-sdk:dynamodb:query",
      "Next": "Map",
      "ResultPath": "$.result"
    },
    "Map": {
      "Type": "Map",
      "ItemProcessor": {
        "ProcessorConfig": {
          "Mode": "INLINE"
        },
        "StartAt": "Send message",
        "States": {
          "Send message": {
            "Type": "Task",
            "Resource": "arn:${partition}:states:::states:startExecution",
            "Parameters": {
              "StateMachineArn": "${MessageSfnArn}",
              "Input": {
                "body": {
                  "userId.$": "$.userId.S",
                  "message.$": "$.message.S"
                }
              }
            },
            "Next": "Delete message",
            "ResultPath": "$.result.sendmessage"
          },
          "Delete message": {
            "Type": "Task",
            "Resource": "arn:${partition}:states:::dynamodb:deleteItem",
            "Parameters": {
              "TableName": "${MessagesTable}",
              "Key": {
                "userId": {
                  "S.$": "$.userId.S"
                },
                "timestamp": {
                  "S.$": "$.timestamp.S"
                }
              }
            },
            "End": true,
            "ResultPath": "$.result.delete"
          }
        }
      },
      "Next": "More pages?",
      "ItemsPath": "$.result.Items",
      "ResultPath": null
    },
    "More pages?": {
      "Type": "Choice",
      "Choices": [
        {
          "Variable": "$.result.LastEvaluatedKey",
          "IsPresent": true,
          "Next": "List messages"
        }
      ],
      "Default": "Pass"
    },
    "Pass": {
      "Type": "Pass",
      "End": true
    }
  }
}