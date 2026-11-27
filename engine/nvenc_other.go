//go:build !windows

package main

// (the NVIDIA encoder inside the engine is called through the Windows driver: nvenc_windows.go)
func openEncoder(c encCfg) (picEncoder, error) {
	return nil, &noEncoderError{"the NVIDIA encoder inside the engine is for Windows"}
}
