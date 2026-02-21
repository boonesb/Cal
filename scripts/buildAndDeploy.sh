#!/usr/bin/env bash
set -ex

UNDEPLOY=false

while getopts ":u" opt; do
  case $opt in
    u)
      UNDEPLOY=true
      ;;
    \?)
      echo "Invalid option: -$OPTARG" >&2
      exit 1
      ;;
  esac
done

if [ "$UNDEPLOY" = true ]; then
  echo "Undeploying Application..."
  # your undeploy commands here
  # e.g. docker compose down, pm2 stop, etc.
  firebase hosting:disable
  exit 0
fi

echo "git pull"

git checkout main
git pull origin main

echo "npm install"

npm install

echo "npm run build"

npm run build

echo "Deploying Application..."

firebase deploy --only hosting

echo "Done."
