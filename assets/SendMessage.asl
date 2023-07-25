{
  "Comment": "A description of my state machine",
  "StartAt": "Get connectionId",
  "States": {
    "Get connectionId": {
      "Type": "Task",
      "Resource": "arn:${partition}:states:::dynamodb:getItem",
      "Parameters": {
        "TableName": "${ConnectionsTable}",
        "Key": {
          "userId": {
            "S.$": "$.body.userId"
          }
        },
        "ProjectionExpression": "connectionId"
      },
      "Next": "Send message?",
      "ResultPath": "$.result.connection"
    },
    "Send message?": {
      "Type": "Choice",
      "Choices": [
        {
          "Variable": "$.result.connection.Item.connectionId",
          "IsPresent": true,
          "Comment": "Has connectionId",
          "Next": "Send message"
        }
      ],
      "Default": "Store message"
    },
    "Send message": {
      "Type": "Task",
      "Resource": "arn:${partition}:states:::apigateway:invoke",
      "Parameters": {
        "ApiEndpoint": "${ApiEndpoint}",
        "Method": "POST",
        "Stage": "prod",
        "Path.$": "States.Format('@connections/{}', $.result.connection.Item.connectionId.S)",
        "RequestBody": {
          "Payload.$": "$.body.message"
        },
        "AuthType": "IAM_ROLE"
      },
      "ResultPath": "$.result.invoke",
      "Catch": [
        {
          "ErrorEquals": [
            "ApiGateway.410"
          ],
          "Next": "Store message",
          "Comment": "410 - not connected",
          "ResultPath": "$.result.invoke"
        }
      ],
      "End": true
    },
    "Store message": {
      "Type": "Task",
      "Resource": "arn:${partition}:states:::dynamodb:putItem",
      "Parameters": {
        "TableName": "${MessagesTable}",
        "Item": {
          "userId": {
            "S.$": "$.body.userId"
          },
          "timestamp": {
            "S.$": "$$.State.EnteredTime"
          },
          "message": {
            "S.$": "$.body.message"
          }
        }
      },
      "End": true,
      "ResultPath": "$.result.storemessage"
    }
  }
}