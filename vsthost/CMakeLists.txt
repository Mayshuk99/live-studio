# Live Studio — VST3 host for the Master inserts (ls-vst).
# The VST 3 SDK (MIT license) is fetched into ./vst3sdk by the build (see .github/workflows/build.yml).
cmake_minimum_required(VERSION 3.19)
project(ls-vst CXX C)

set(VST3_SDK_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/vst3sdk" CACHE PATH "VST 3 SDK")
option(LSVST_TEST_PLUGINS "Also build the SDK's sample plug-ins (for tests)" OFF)

set(SMTG_ENABLE_VSTGUI_SUPPORT OFF CACHE BOOL "" FORCE)
set(SMTG_ENABLE_VST3_HOSTING_EXAMPLES OFF CACHE BOOL "" FORCE)
set(SMTG_ENABLE_VST3_PLUGIN_EXAMPLES ${LSVST_TEST_PLUGINS} CACHE BOOL "" FORCE)
set(SMTG_RUN_VST_VALIDATOR OFF CACHE BOOL "" FORCE)
set(SMTG_CREATE_PLUGIN_LINK OFF CACHE BOOL "" FORCE)
set(SMTG_USE_STATIC_CRT ON CACHE BOOL "" FORCE) # no Visual C++ runtime needed on the church PC
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
set(SMTG_PLUGIN_TARGET_USER_PROGRAM_FILES_COMMON OFF CACHE BOOL "" FORCE)

add_subdirectory(${VST3_SDK_ROOT} vst3sdk EXCLUDE_FROM_ALL)

add_executable(ls-vst
    host.cpp
    ${VST3_SDK_ROOT}/public.sdk/source/vst/hosting/plugprovider.cpp
    ${VST3_SDK_ROOT}/public.sdk/source/common/memorystream.cpp
)
# the part that opens .vst3 files is different on each system
if(WIN32)
    target_sources(ls-vst PRIVATE ${VST3_SDK_ROOT}/public.sdk/source/vst/hosting/module_win32.cpp)
elseif(APPLE)
    target_sources(ls-vst PRIVATE ${VST3_SDK_ROOT}/public.sdk/source/vst/hosting/module_mac.mm)
else()
    target_sources(ls-vst PRIVATE ${VST3_SDK_ROOT}/public.sdk/source/vst/hosting/module_linux.cpp)
endif()
target_compile_features(ls-vst PRIVATE cxx_std_17)
target_link_libraries(ls-vst PRIVATE sdk_hosting sdk_common base pluginterfaces)
if(WIN32)
    target_link_libraries(ls-vst PRIVATE ole32 user32)
    target_compile_definitions(ls-vst PRIVATE UNICODE _UNICODE)
    set_target_properties(ls-vst PROPERTIES WIN32_EXECUTABLE OFF)
    target_compile_options(ls-vst PRIVATE /EHa) # lets a plug-in crash inside process() be caught
else()
    target_link_libraries(ls-vst PRIVATE dl pthread)
endif()
