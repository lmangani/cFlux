<img src="https://user-images.githubusercontent.com/1423657/50525862-772d8480-0ade-11e9-95d5-d5150332eb18.png" width=120>

# cFlux
Experimental, unoptimized InfluxDB API to Clickhouse DB Gateway prototype for Timeseries. 

**Unstable, Experimental, Dangerous! Do not use this!**

![ezgif com-optimize 14](https://user-images.githubusercontent.com/1423657/50405673-8f3c9580-07b8-11e9-8f41-7577246488d6.gif)


### Usage
##### Start Server
```
CLICKHOUSE_SERVER=my.clickhouse.server npm start
```

The server attempts emulating an InfluxDB API instance and can accept line protocol and query requests from Telegraf, Chronograf, Kapacitor and potentially clients with (extremely) basic features.

###### API Status
- [x] Endpoint `/write`
  - [x] line protocol parser
  - [x] clickhouse insert statement
  - [x] clickhouse bulk inserts w/ LRU
- [ ] Endpoint `/query`
  - [x] IFQL Parser
  - [x] SHOW DATABASES
  - [x] SHOW MEASUREMENTS
  - [x] SHOW RETENTION POLICIES (fake)
  - [x] SHOW TAG KEYS
  - [x] SHOW TAG VALUES
  - [x] SHOW FIELDS KEYS
  - [ ] SELECT
    - [x] Fields
    - [x] Tags
    - [x] Timerange _(now)_
    - [ ] Group By
    
------

##### POST Metrics `/write`
The `/write` endpoint expects HTTP POST data using the InfluxDB line protocol:
```
<measurement>[,<tag_key>=<tag_value>[,<tag_key>=<tag_value>]] <field_key>=<field_value>[,<field_key>=<field_value>] [<timestamp>]
```
###### Example
```
 curl -d "statistics_method,cseq=OPTIONS 100=1,OPTIONS=1 1545424651000000000" \
      -X POST 'http://localhost:8686/write?db=mystats'
```

