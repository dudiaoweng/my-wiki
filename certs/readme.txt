第一步：创建根证书 (CA)
# 1. 生成根证书私钥 (ca.key)
openssl genrsa -out ca.key 4096
# 2. 生成根证书 (ca.crt)，有效期为10年
openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 -out ca.crt -subj "/C=CN/ST=32/L=00/O=11/OU=00/CN=JSCA"

第二步：生成服务器证书
# 1. 生成服务器私钥 (server.key)
openssl genrsa -out server.key 2048
# 2. 生成证书签名请求 (server.csr)
openssl req -new -key server.key -out server.csr -subj "/C=CN/ST=32/L=00/O=11/OU=00/CN=localhost"
# 3. 使用 CA 证书签发服务器证书 (server.crt)
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 365 -sha256

第三步：生成客户端证书

#openssl方案，CN不支持中文

# 1. 生成客户端私钥 (client.key)
openssl genrsa -out client.key 2048
# 2. 生成证书签名请求 (client.csr)
openssl req -new -key client.key -out client.csr -subj "/C=CN/ST=32/L=00/O=11/OU=00/CN=zhouheng 320923197608270018"
或
openssl req -new -key client.key -out client.csr -config client.conf
# 3. 使用 CA 证书签发客户端证书 (client.crt)
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out client.crt -days 365 -sha256
# 4.将客户端证书打包为 PKCS#12 格式（可选）
openssl pkcs12 -export -out client.p12 -inkey client.key -in client.crt -certfile ca.crt


#keytool+openssl方案，CN支持中文

# 1. 生成客户端密钥库并创建密钥对
keytool -genkeypair -alias client -keyalg RSA -keysize 2048 -keystore zhouheng.jks -storepass 760803 -keypass 123456
# 2. 生成证书签名请求（CSR）
keytool -certreq -alias client -keystore zhouheng.jks -storepass 760803 -file zhouheng.csr
# 3. 使用 openssl 签名（如果你的根证书是ca .crt 和ca .key 文件）
openssl x509 -req -in zhouheng.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out zhouheng.crt -days 365
# 4. 导入根证书（作为信任的CA）
keytool -import -alias ca -keystore zhouheng.jks -storepass 760803 -file ca.crt
# 5. 导入签名后的客户端证书（必须与生成时的 -alias 一致）
keytool -import -alias client -keystore zhouheng.jks -storepass 760803 -file zhouheng.crt
# 6. 导出为通用的 PKCS#12 格式
keytool -importkeystore -srckeystore zhouheng.jks -srcstorepass 760803 -destkeystore zhouheng.p12 -deststoretype PKCS12 -deststorepass 123456



client.conf
[req]
distinguished_name = req_distinguished_name
prompt = no

[req_distinguished_name]
C = CN
ST = 32
L = 00
O = 11
OU = 00
CN = 周衡 320923197608270018