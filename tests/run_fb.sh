set -e
g++ -std=c++17 -O2 -march=x86-64-v2 -Wall -Wextra -o dsp_test dsp_test.cpp
G=$(head -1 loop_gain.txt)
./dsp_test loop speech.f32 room_ir.f32 loop_off.f32 $G -1
./dsp_test loop speech.f32 room_ir.f32 loop_on50.f32 $G 0.5 notches_50.txt
./dsp_test loop speech.f32 room_ir.f32 loop_on.f32 $G 1.0 notches_100.txt
python3 -I analyze_loop.py
for s in 0.5 1.0; do echo "== speech fb=$s"; ./dsp_test open speech.f32 o.f32 $s 0 0; echo "== music fb=$s"; ./dsp_test open music.f32 o.f32 $s 0 0; done
