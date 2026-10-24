.PHONY: lint test build check

lint:
	npm run typecheck

test:
	npm test

build:
	npm run build

check: lint test build
