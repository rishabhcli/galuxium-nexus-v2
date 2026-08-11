SHELL := /bin/sh
.DEFAULT_GOAL := verify-all

.PHONY: bootstrap boundaries build check db-migrate dependencies-check dependencies-verify dev-down dev-e2e-server dev-health dev-preflight dev-up eval format format-check full-verify lint release-check run-local test test-coverage test-e2e test-integration typecheck verify-all

bootstrap:
	node tooling/bootstrap.mjs

boundaries:
	node tooling/run-npm.mjs run boundaries

build:
	node tooling/run-npm.mjs run build

check:
	node tooling/run-npm.mjs run check

db-migrate:
	node tooling/run-npm.mjs run db:migrate

dependencies-check:
	node tooling/run-npm.mjs run dependencies:check

dependencies-verify:
	node tooling/run-npm.mjs run dependencies:verify

dev-down:
	node tooling/run-npm.mjs run dev:down

dev-e2e-server:
	node tooling/run-npm.mjs run dev:e2e-server

dev-health:
	node tooling/run-npm.mjs run dev:health

dev-preflight:
	node tooling/run-npm.mjs run dev:preflight

dev-up:
	node tooling/run-npm.mjs run dev:up

eval:
	node tooling/unavailable-gate.mjs eval

format:
	node tooling/run-npm.mjs run format

format-check:
	node tooling/run-npm.mjs run format:check

full-verify: bootstrap
	node tooling/run-npm.mjs run full-verify

lint:
	node tooling/run-npm.mjs run lint

release-check:
	node tooling/unavailable-gate.mjs release-check

run-local: bootstrap
	node tooling/run-npm.mjs run run-local

test:
	node tooling/run-npm.mjs test

test-coverage:
	node tooling/run-npm.mjs run test:coverage

test-e2e: bootstrap
	node tooling/run-npm.mjs run build
	node tooling/run-npm.mjs run test:e2e

test-integration: run-local
	node tooling/run-npm.mjs run test:integration

typecheck:
	node tooling/run-npm.mjs run typecheck

verify-all: full-verify
