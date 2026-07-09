SHELL := /bin/bash

.PHONY: run deploy extension

run:
	@source $$HOME/.nvm/nvm.sh && nvm use && npm run dev

deploy:
	@source $$HOME/.nvm/nvm.sh && nvm use && npm run deploy

extension:
	@source $$HOME/.nvm/nvm.sh && nvm use && npm run build:extension
