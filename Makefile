.PHONY: help setup install test test-js test-all run docker-build docker-up docker-down update update-auto clean

help:
	@echo "Plasmid Editor - available commands"
	@echo "==================================="
	@echo "setup        - Create a virtual environment and install dependencies"
	@echo "test         - Run the backend test suite"
	@echo "test-js      - Check frontend syntax and run the helper tests (needs node)"
	@echo "test-all     - Both of the above"
	@echo "run          - Run the development server on port 5001"
	@echo "docker-build - Build the container image"
	@echo "docker-up    - Start the development stack"
	@echo "docker-down  - Stop the development stack"
	@echo "update       - Pull the published image, health-check, roll back on failure"
	@echo "update-auto  - Enable Watchtower so the container updates itself"
	@echo "clean        - Remove caches and build artefacts"

setup:
	python3 -m venv .venv
	./.venv/bin/pip install --upgrade pip
	./.venv/bin/pip install -r requirements.txt
	mkdir -p data

install:
	./.venv/bin/pip install -r requirements.txt

test:
	./.venv/bin/pytest -q

test-js:
	for f in app/static/js/*.js; do node --check "$$f"; done
	node tests/js/helpers.test.js

test-all: test test-js

run:
	EDITOR_DATABASE_PATH=./data/plasmid_editor.db \
	ADMIN_USERNAME=admin ADMIN_PASSWORD=devpassword \
	./.venv/bin/python -m flask --app app.main run --port 5001 --debug

docker-build:
	docker compose build

docker-up:
	docker compose up

docker-down:
	docker compose down

update:
	./scripts/update.sh

update-auto:
	docker compose -f docker-compose.prod.yml -f docker-compose.watchtower.yml up -d
	@echo "Watchtower is running; the container will update itself when a new image is published."

clean:
	find . -type d -name "__pycache__" -prune -exec rm -rf {} +
	find . -type d -name ".pytest_cache" -prune -exec rm -rf {} +
	find . -type f -name "*.pyc" -delete
	rm -rf htmlcov .coverage
