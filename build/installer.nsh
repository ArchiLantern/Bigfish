; Bigfish 自定义安装欢迎页
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "欢迎安装 Bigfish"
  !define MUI_WELCOMEPAGE_TEXT "大约等待十分钟安装配置，后续就可以尽情使用啦！$\r$\n$\r$\n安装过程中进度条可能长时间不动，属正常现象，请耐心等待。"
  !insertmacro MUI_PAGE_WELCOME
!macroend
