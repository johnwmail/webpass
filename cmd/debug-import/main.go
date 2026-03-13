//go:build ignore

// Debug script: Opens browser to WebPass for manual import testing
// Run: go run cmd/debug-import/main.go
// Then manually: 1) Login 2) Open Settings 3) Click Import 4) Select file
// Watch console output for debug logs

package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/chromedp"
)

func main() {
	baseURL := os.Getenv("TEST_BASE_URL")
	if baseURL == "" {
		baseURL = "http://localhost:3000"
	}

	fmt.Printf("=== WebPass Import Debugger ===\n")
	fmt.Printf("Opening: %s\n", baseURL)
	fmt.Println("\nInstructions:")
	fmt.Println("1. Log in to your account")
	fmt.Println("2. Click Settings (⚙️)")
	fmt.Println("3. Click '📥 Import .password-store'")
	fmt.Println("4. Select your .tgz file")
	fmt.Println("5. Watch console logs below for debugging info\n")

	// ChromeDP options - show browser for visual debugging
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.Flag("headless", false),
		chromedp.Flag("window-size", "1400,900"),
		chromedp.Flag("disable-gpu", true),
		chromedp.Flag("no-sandbox", true),
		chromedp.Flag("disable-dev-shm-usage", true),
	)

	allocCtx, cancelAlloc := chromedp.NewExecAllocator(context.Background(), opts...)
	defer cancelAlloc()

	ctx, cancelCtx := chromedp.NewContext(allocCtx,
		chromedp.WithLogf(func(format string, args ...interface{}) {
			log.Printf("[chromedp] "+format, args...)
		}),
	)
	defer cancelCtx()

	ctx, cancel := context.WithTimeout(ctx, 300*time.Second)
	defer cancel()

	// Listen for console messages
	go func() {
		chromedp.ListenTarget(ctx, func(ev interface{}) {
			if ev, ok := ev.(*runtime.EventConsoleAPICalled); ok {
				var args []string
				for _, arg := range ev.Args {
					if arg.Value != nil {
						args = append(args, arg.Value.String())
					} else if arg.Description != "" {
						args = append(args, arg.Description)
					}
				}
				fmt.Printf("  [Console %s] %s\n", ev.Type, strings.Join(args, " "))
			}
			if ev, ok := ev.(*runtime.EventExceptionThrown); ok {
				fmt.Printf("  [Exception] %v\n", ev.ExceptionDetails)
			}
		})
	}()

	// Navigate
	if err := chromedp.Run(ctx, chromedp.Navigate(baseURL)); err != nil {
		log.Fatalf("Navigation failed: %v", err)
	}

	fmt.Println("✓ Browser opened - follow instructions above")
	fmt.Println("Press Ctrl+C to exit\n")

	// Keep running
	select {
	case <-ctx.Done():
		fmt.Println("Session ended")
	}
}
