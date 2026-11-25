# ls-ndi — NDI helper

Receives an NDI® source for Live Studio's native engine (`--recv`), lists the sources on the network (`--list`),
and sends a test picture (`--send`, for tests). See the top of `ls-ndi.cpp`.

- `ndi/` — the NDI SDK header files, copied unchanged from the NDI SDK 6.3 (each carries its MIT license notice).
- The NDI Runtime is **not** included: it is installed with the free NDI Tools (https://ndi.video) and loaded when needed
  (`NDI_RUNTIME_DIR_V6` / `V5`, then the system path).

NDI® is a registered trademark of Vizrt NDI AB.
