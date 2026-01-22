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
            "Assign": {
              "connectionId": "{% $states.result.Item.connectionId.S %}"
            },
            "Next": "Send message?"
          },
          "Send message?": {
            "Type": "Choice",
            "Choices": [
              {
                "Condition": "{% $connectionId %}",
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
              "Path": "{% '@connections/' & $connectionId %}",
              "RequestBody": {
                "Payload": "{% $states.input.body.message %}"
              },
              "AuthType": "IAM_ROLE"
            },
            "Catch": [
              {
                "ErrorEquals": ["ApiGateway.410"],
                "Next": "Store message"
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
