.PHONY: build clean test run

build:
	go build -o webpass-server ./cmd/srv

clean:
	rm -f webpass-server

test:
	go test ./...

run: build
	./webpass-server
