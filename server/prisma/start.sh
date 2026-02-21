#!/usr/bin/env bash
set -e
cd server
npm install
npx prisma generate
npx prisma db push
npm run start
