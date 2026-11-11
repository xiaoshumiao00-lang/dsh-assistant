# ESP32-S3-BOX-3B 鹈鹕固件
#
# 先安装 ESP-IDF v5.3（BSP 3.x 要求 >=5.3），然后在 PowerShell 里：
#   . $env:IDF_PATH\export.ps1
#   idf.py set-target esp32s3
#   idf.py build
cmake_minimum_required(VERSION 3.16)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)

project(tihu_box3)
