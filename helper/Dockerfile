FROM python:3.13-slim-bookworm@sha256:5024f48ba9441d4b13a95d3945abc6365538e3a31109833367a1923523c6efed
WORKDIR /app
COPY helper/requirements.lock.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
RUN python -c "import urllib.request,hashlib,pathlib; p=pathlib.Path('/app/de421.bsp'); urllib.request.urlretrieve('https://ssd.jpl.nasa.gov/ftp/eph/planets/bsp/de421.bsp',p); assert hashlib.sha256(p.read_bytes()).hexdigest()=='a20a7139da04cbc462454634918e9a9ca69127044e2cc9d4f9c16e238d2deedc'"
COPY helper/service.py /app/service.py
COPY helper/rss_news.py /app/rss_news.py
COPY helper/community.py /app/community.py
COPY helper/publisher.py /app/publisher.py
COPY helper/sst.py /app/sst.py
RUN mkdir -p /app/gpx /data/ocean-cache
COPY config/news-feeds.json /app/news-feeds.json
RUN useradd --uid 10001 --create-home helper && mkdir -p /data/ocean-cache && chown -R 10001:10001 /data/ocean-cache
USER helper
EXPOSE 8080
CMD ["python", "service.py"]
COPY helper/providers.py /app/providers.py
COPY config/config.example.json /app/report.example.json
