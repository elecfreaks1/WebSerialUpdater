
window.onload = function () {
    var app = new Vue({
        el: '#app',
        data: {
            port: null,
            writer: null,
            reader: null,
            firmware: [],
            isPortOpen: false,
            isSending: false,
            fileBuffer: null,
            fileSendIndex: 0,
            fileCheckSum: 0,
            fileSendProgress: 0,
            fileSendStatus: 0,// 0:未开始 1:正在发送
            fileSendTask: null,
            fileOptions: [
                {
                    value: "NezhaPro",
                    label: "NezhaPro",
                    children: [
                        {
                            value: "Nezha_Pro_v1.0.2.bin",
                            label: "v1.0.2"
                        },
                    ]
                },
                {
                    value: "CutebotPro",
                    label: "CutebotPro",
                    children: [
                        {
                            value: "Cutebot_Pro_v2.0.1.bin",
                            label: "v2.0.1"
                        },
                    ]
                },
                {
                    value: "TPbotPro",
                    label: "TPbotPro",
                    children: [
                        {
                            value: "TPbot_Pro_v2.0.1.bin",
                            label: "v2.0.1"
                        },
                    ]
                },
            ],
            uploadBuffer: null,
            repeatUpdateFlag: false
        },
        mounted() {
            const handshakeData = new Uint8Array([0xEF]);
            setInterval(async () => {
                if (this.fileSendStatus == 1 && this.port != null) {
                    try {
                        await this.writer.write(handshakeData);
                    } catch (err) {
                        console.log(err)
                    }
                }
            }, 5)
        },
        methods: {
            async selectFile() {
                let file = document.getElementById('fileInput').files[0];
                if (!file) {
                    return;
                }
                let reader = new FileReader();
                reader.onload = async (e) => {
                    let lastOptionIndex = this.fileOptions.length - 1
                    if (this.fileOptions[lastOptionIndex].value == 'File') {
                        this.fileOptions.splice(lastOptionIndex, 1);
                    }
                    this.fileOptions.push({
                        value: "File",
                        label: "File",
                        children: [
                            {
                                value: file.name,
                                label: file.name
                            }
                        ]
                    })
                    this.firmware = ['File', file.name];
                    this.uploadBuffer = new Uint8Array(e.target.result);
                    this.fileBuffer = this.uploadBuffer;
                };
                reader.readAsArrayBuffer(file);
            },
            async firmwareChange() {
                if (this.firmware[0] == 'File') {
                    this.fileBuffer = this.uploadBuffer;
                } else {
                    let url = `firmware/${this.firmware[1]}`;
                    // 发送HTTP请求以下载文件
                    const response = await fetch(url);
                    if (!response.ok) {
                        await app.$alert('Firmware download failed!');
                        this.firmware = []
                        return;
                    }
                    this.fileBuffer = new Uint8Array(await response.arrayBuffer());
                }
            },
            async openPort() {
                try {
                    this.port = await navigator.serial.requestPort();
                    await this.port.open({
                        baudRate: 115200,
                        dataBits: 8,
                        stopBits: 1,
                        parity: "none",
                        flowControl: "none"
                    });
                    // 添加一个短暂的延迟
                    await new Promise(resolve => setTimeout(resolve, 100));
                    this.writer = this.port.writable.getWriter();
                    this.reader = this.port.readable.getReader();
                    this.port.ondisconnect = () => {
                        this.$message.error('Serial device disconnected!');
                        this.isPortOpen = false;
                        try {
                            this.stopFileSend();
                            this.port.close()
                        } finally {
                            this.port = null
                        }

                    }
                    this.isPortOpen = true;
                } catch (err) {
                    this.isPortOpen = false;
                    this.port.close()
                    this.port = null
                    return;
                }
            },
            async closePort() {
                try {
                    await this.writer.releaseLock()
                } finally { }
                try {
                    await this.reader.releaseLock()
                } finally { }
                try {
                    await this.port.close();
                } finally { }
                this.isPortOpen = false;
                this.port = null
            },
            async startFileSend() {

                if (this.isPortOpen == false) {
                    this.$message.warning('Port not conneted!');
                    return;
                }

                if (this.firmware[0] == null || this.firmware[0] == undefined) {
                    this.$message.warning('Program firmware not selected!');
                    return;
                }

                this.isSending = true;
                this.fileSendIndex = 0;
                this.fileSendStatus = 1;
                this.fileCheckSum = 0;
                this.startHandleSerialData();

            },
            async stopFileSend() {
                this.fileSendStatus = 0;
                this.isSending = false;
                this.fileSendProgress = 0;
            },
            async startHandleSerialData() {
                while (true) {
                    const { value, done } = await this.reader.read();
                    for (let data of value) {
                        switch (this.fileSendStatus) {
                            case 1: // 收到握手ACK
                                if (data == 0xAA) {
                                    this.fileSendStatus = 2;
                                    this.fileSendProgress = 5;
                                    // 发送头信息(帧头 + 文件大小 + 校验)
                                    let len_1 = this.fileBuffer.length >> 24 & 0xFF;
                                    let len_2 = this.fileBuffer.length >> 16 & 0xFF;
                                    let len_3 = this.fileBuffer.length >> 8 & 0xFF;
                                    let len_4 = this.fileBuffer.length & 0xFF;
                                    let checkSum = len_1 + len_2 + len_3 + len_4;
                                    this.writer.write(new Uint8Array([0xAA, len_1, len_2, len_3, len_4, checkSum & 0xFF]));
                                }
                                break;
                            case 2: // 收到头信息ACK || 收到数据包ACK
                                if (data == 0xAA) {
                                    // 头信息ACK反馈成功，初始化文件下标开始发送
                                    let packageLen = Math.min(this.fileBuffer.length - this.fileSendIndex, 1024);
                                    let buf = new Uint8Array(packageLen + 4);

                                    buf[0] = 0xAA;
                                    buf[1] = packageLen >> 8 & 0xFF;
                                    buf[2] = packageLen & 0xFF;
                                    let checkSum = buf[1] + buf[2];
                                    for (let i = 0; i < packageLen; i++) {
                                        let data = this.fileBuffer[this.fileSendIndex++];
                                        buf[i + 3] = data;
                                        checkSum += data;
                                    }
                                    buf[packageLen + 3] = checkSum & 0xFF;
                                    this.fileCheckSum += checkSum & 0xFF;
                                    this.writer.write(buf);
                                    // 更新文件发送进度
                                    this.fileSendProgress = 5 + Math.round(this.fileSendIndex * 90 / this.fileBuffer.length);
                                    if (this.fileSendIndex == this.fileBuffer.length) {
                                        this.fileSendStatus = 3;
                                    }
                                }
                                break;
                            case 3: // 文件发送完成ACK
                                if (data == 0xAA) {
                                    this.writer.write(new Uint8Array([0xBB, this.fileCheckSum & 0xFF]));
                                    this.fileSendStatus = 4;
                                }
                                break;
                            case 4:
                                if (data == 0xAA) {
                                    this.fileSendProgress = 100;
                                    if (this.repeatUpdateFlag) {
                                        this.fileSendProgress = 0;
                                        this.isSending = true;
                                        this.fileSendIndex = 0;
                                        this.fileSendStatus = 1;
                                        this.fileCheckSum = 0;
                                    } else {
                                        await app.$alert('Firmware Update Success!');
                                        this.isSending = false;
                                        this.stopFlag = false;
                                        this.fileSendProgress = 0;
                                        this.fileSendStatus = 0;
                                        return;
                                    }
                                }
                        }
                    }
                    if (done) {
                        return;
                    }
                }
            }
        },
    })

}