#!/bin/sh
cd "$(dirname "$0")"
while true
do
  git pull
  node --env-file=.env index.ts
  sleep 10
done
