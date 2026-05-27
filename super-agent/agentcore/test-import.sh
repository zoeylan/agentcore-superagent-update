#!/bin/bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REPO="${ACCOUNT_ID}.dkr.ecr.ap-northeast-1.amazonaws.com/super-agent-agentcore"

echo "Testing import in container (from /app)..."
docker run --rm -w /app "${ECR_REPO}:latest" node --input-type=module -e 'import { GetBrowserSessionCommand } from "@aws-sdk/client-bedrock-agentcore"; console.log("OK:", !!GetBrowserSessionCommand);'
