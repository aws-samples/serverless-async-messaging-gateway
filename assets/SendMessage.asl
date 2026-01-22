{
  "QueryLanguage": "JSONata",
  "StartAt": "Map",
  "States": {
    "Map": {
      "Type": "Map",
      "MaxConcurrency": 1,
      "ItemProcessor": {
        "ProcessorConfig": {
          "Mode": "INLINE"
        },
        "StartAt": "Get connectionId",
        "States": {
          "Get connectionId": {
            "Type": "Task",
            "Resource": "arn:${partition}:states:::dynamodb:getItem",
            "Arguments": {
              "TableName": "${ConnectionsTable}",
              "Key": {
                "userId": {
                  "S": "{% $states.input.body.userId %}"
                }
              },
              "ProjectionExpression": "connectionId"
            },
            "Next": "Send message?",
            "Output": {
              "body": "{% $states.input.body %}",
              "result": {
                "connection": "{% $states.result %}"
              }
            }
          },
          "Send message?": {
            "Type": "Choice",
            "Choices": [
              {
                "Condition": "{% $exists($states.input.result.connection.Item.connectionId) %}",
                "Comment": "Has connectionId",
                "Next": "Send message"
              }
            ],
            "Default": "Store message"
          },
          "Send message": {
            "Type": "Task",
            "Resource": "arn:${partition}:states:::apigateway:invoke",
            "Arguments": {
              "ApiEndpoint": "${ApiEndpoint}",
              "Method": "POST",
              "Stage": "${ApiStage}",
              "Path": "{% '@connections/' & $states.input.result.connection.Item.connectionId.S %}",
              "RequestBody": {
                "Payload": "{% $states.input.body.message %}"
              },
              "AuthType": "IAM_ROLE"
            },
            "Catch": [
              {
                "ErrorEquals": ["ApiGateway.410"],
                "Next": "Store message",
                "Comment": "410 - not connected",
                "Output": {
                  "body": "{% $states.input.body %}",
                  "result": {
                    "connection": "{% $states.input.result.connection %}"
                  }
                }
              }
            ],
            "End": true
          },
          "Store message": {
            "Type": "Task",
            "Resource": "arn:${partition}:states:::dynamodb:putItem",
            "Arguments": {
              "TableName": "${MessagesTable}",
              "Item": {
                "userId": {
                  "S": "{% $states.input.body.userId %}"
                },
                "timestamp": {
                  "N": "{% $string($states.input.body.timestamp) %}"
                },
                "message": {
                  "S": "{% $states.input.body.message %}"
                }
              }
            },
            "End": true
          }
        }
      },
      "End": true
    }
  }
}
