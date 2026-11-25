# Live Studio — NDI helper (ls-ndi): finds and receives NDI sources for the native engine.
# Uses only the NDI SDK's header files (MIT license, in ./ndi); the NDI Runtime itself is loaded at run time from
# the NDI Tools installed on the computer. NDI® is a registered trademark of Vizrt NDI AB.
cmake_minimum_required(VERSION 3.19)
project(ls-ndi CXX)
add_executable(ls-ndi ls-ndi.cpp)
target_compile_features(ls-ndi PRIVATE cxx_std_17)
target_include_directories(ls-ndi PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
if(MSVC)
    set_property(TARGET ls-ndi PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded") # no Visual C++ runtime needed
    target_compile_options(ls-ndi PRIVATE /O2 /W3 /wd4996)
else()
    target_compile_options(ls-ndi PRIVATE -O2 -Wall -Wno-deprecated-declarations)
    target_link_libraries(ls-ndi PRIVATE ${CMAKE_DL_LIBS} pthread)
endif()
