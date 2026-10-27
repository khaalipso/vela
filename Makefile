# Vela: the same targets on Linux and macOS; platform details live in scripts/.
.PHONY: install launch update uninstall test dev try clean help

install:   ## Build Vela and install the app and the `vela` command
	@scripts/install.sh

launch:    ## Start the installed app
	@scripts/launch.sh

update:    ## Pull the repository and install again
	@git pull --ff-only
	@scripts/install.sh

uninstall: ## Remove the app and the command (spaces and settings are kept)
	@scripts/uninstall.sh

test:      ## Rust and interface tests, type check and build, all headless
	cargo test --workspace
	pnpm -C ui install --frozen-lockfile
	pnpm -C ui check
	pnpm -C ui test
	pnpm -C ui build

dev:       ## Run the app from the sources with hot reload
	pnpm -C ui install --frozen-lockfile
	cd app && ../ui/node_modules/.bin/tauri dev

try:       ## Run the app on throwaway demo repos
	@scripts/try.sh

clean:     ## Remove build outputs
	cargo clean
	rm -rf ui/dist

help:
	@grep -E '^[a-z]+:.*##' Makefile | sed 's/:.*## /\t/'
