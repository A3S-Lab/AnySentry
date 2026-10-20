#!/usr/bin/env bash
# Start the observation fixture. AnySentry itself does not need Docker;
# this Agent container does. The container name must stay langchain-glm-agent.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
IMAGE=langchain-glm-lab:latest
LOADED_TAG=langchain-glm-lab:uos-arm64
NAME=langchain-glm-agent
ENV_FILE=$ROOT/glm.env
IMAGE_TAR=$ROOT/langchain-glm-lab-arm64.tar

command -v docker >/dev/null 2>&1 || {
  echo "docker is required to start $NAME" >&2
  exit 1
}
[[ -f $ENV_FILE ]] || {
  echo "copy $ROOT/glm.env.example to $ENV_FILE and set GLM_API_KEY" >&2
  exit 1
}
grep -q '^GLM_API_KEY=.\+' "$ENV_FILE" || {
  echo "GLM_API_KEY is empty in $ENV_FILE" >&2
  exit 1
}

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  if docker image inspect "$LOADED_TAG" >/dev/null 2>&1; then
    docker tag "$LOADED_TAG" "$IMAGE"
  else
    [[ -f $IMAGE_TAR ]] || {
      echo "image $IMAGE is missing and $IMAGE_TAR was not found" >&2
      exit 1
    }
    docker load -i "$IMAGE_TAR"
    docker tag "$LOADED_TAG" "$IMAGE"
  fi
fi

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d \
  --name "$NAME" \
  --restart unless-stopped \
  --env-file "$ENV_FILE" \
  -p 8000:8000 \
  "$IMAGE"
echo "started $NAME from $IMAGE on port 8000"
echo "curl -sS http://127.0.0.1:8000/"
