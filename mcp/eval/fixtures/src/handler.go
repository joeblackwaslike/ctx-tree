package main

import "fmt"

func handleRequest(req string) string {
    return fmt.Sprintf("handled: %s", req)
}
