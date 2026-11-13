# 组件依赖说明：
#   esp-box-3          —— BSP（屏幕/触摸/ES8311/ES7210/按键），由 idf_component.yml 拉取
#   esp_websocket_client —— WebSocket 客户端（IDF 自带；manifest 里也钉了版本）
#   json               —— cJSON（IDF 自带）
#   mbedtls            —— base64 编解码（IDF 自带）
idf_component_register(
    SRCS
        "main.c"
        "tihu_net.c"
        "tihu_wifi.c"
        "tihu_provision.c"
        "tihu_discover.c"
        "tihu_protocol.c"
        "tihu_audio.c"
        "tihu_volume.c"
        "tihu_touch.c"
        "tihu_ota.c"
        "tihu_wake.c"
        "ui.c"
        "ui_board.c"
        "ui_progress.c"
        "ui_done.c"
        "font/tihu_font_20.c"
        "font/tihu_font_15.c"
    INCLUDE_DIRS
        "."
        "font"
    REQUIRES
        # esp_websocket_client 由 idf_component.yml 带入，组件名由组件管理器
        # 统一成命名空间形式；不要在这里硬写 esp_websocket_client。
        esp_wifi
        esp_netif
        esp_event
        esp_timer
        # 配网页用的是 IDF 自带的 esp_http_server（不引额外组件）
        esp_http_server
        # OTA 客户端：esp_http_client 拉清单/下固件，app_update 提供 esp_ota_*
        esp_http_client
        app_update
        # UDP 广播发现用 lwIP BSD socket（lwip/sockets.h）
        lwip
        json
        mbedtls
        nvs_flash
        # GT911 触摸：BSP 只在**私有**依赖里带 esp_lcd_touch，不会传给 main，
        # 所以 tihu_touch.c 里用 esp_lcd_touch_read_data 必须在这里显式声明。
        espressif__esp_lcd_touch
        espressif__esp-box-3
        # 板内语音唤醒（0.6.0）：ESP-SR AFE + WakeNet9（模型在 app 分区内嵌）
        espressif__esp-sr
)

# 唤醒词模型包（wn9_hilexin，286 KB）编进 app 镜像：
#   main/models/srmodels.bin → 符号 _binary_srmodels_bin_start/end，由 tihu_wake.c 的
#   srmodel_load() 直接解析。**没有 model 分区**，远端 OTA 升 app 就一起换掉模型。
target_add_binary_data(${COMPONENT_LIB} "models/srmodels.bin" BINARY)
