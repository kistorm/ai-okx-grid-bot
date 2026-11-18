FROM python:3.12-slim

ENV TZ=Asia/Shanghai \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends tzdata \
    && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
    && echo $TZ > /etc/timezone \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY bot/ ./bot/
COPY web/ ./web/
COPY tests/ ./tests/

# 状态目录由 volume 挂载；以宿主机用户(1000)身份运行，保证挂载文件归属正确
RUN mkdir -p state && chown -R 1000:1000 /app
USER 1000:1000

EXPOSE 8790
CMD ["python", "-m", "web.app", "--host", "0.0.0.0", "--port", "8790"]
