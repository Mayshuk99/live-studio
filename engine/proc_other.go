//go:build !windows

package main

import (
	"os"
	"os/exec"
)

func setOwnPriority()                   {}
func procAttr(cmd *exec.Cmd, level int) {}

func bigPipe() (r, w *os.File, err error) { return os.Pipe() }
