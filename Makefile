SHELL := /bin/bash

.PHONY: run deploy extension extension-zip

run:
	@source $$HOME/.nvm/nvm.sh && nvm use && npm run dev

deploy:
	@source $$HOME/.nvm/nvm.sh && nvm use && npm run deploy

extension:
	@source $$HOME/.nvm/nvm.sh && nvm use && npm run build:extension

extension-zip: extension
	@cd extension && zip -FSr ../sunlight-tracker-lun-extension-$$(node -p "require('./manifest.json').version").zip manifest.json content.css dist icons
	@echo "Zip ready: sunlight-tracker-lun-extension-$$(node -p "require('./extension/manifest.json').version").zip"
	@echo "Upload at: https://chrome.google.com/webstore/devconsole/"
