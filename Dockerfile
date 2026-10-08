FROM python:3.14.8-slim as base

FROM base as builder
WORKDIR /install

COPY requirements.txt /

RUN pip install --prefix=/install -r /requirements.txt

FROM base as prod
WORKDIR /usr/src/app

COPY --from=builder /install /usr/local
COPY . .

ENTRYPOINT [ "python3" ]
CMD ["main.py"]
