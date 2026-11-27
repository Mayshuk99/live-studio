//go:build !windows

package main

import "os/exec"

func setOwnPriority()                   {}
func procAttr(cmd *exec.Cmd, level int) {}
