SHELL := /bin/bash

.PHONY: run deploy

run:
	@source $$HOME/.nvm/nvm.sh && nvm use && npm run dev

deploy:
	@source $$HOME/.nvm/nvm.sh && nvm use && npm run deploy
