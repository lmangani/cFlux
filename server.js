/*
 * ClickFlux DB
 * InfluxDB to Clickhouse Gateway
 * (C) 2018-2019 QXIP BV
 * Some Rights Reserved.
 */

var debug = process.env.DEBUG || false;
var tsDivide = process.env.TSDIVIDE || 1000000000;

const ifqlparser = require('ifql-parser')();

const clickline = require('clickline');
const ClickHouse = require('@apla/clickhouse');

const clickhouse_options = {
    host: process.env.CLICKHOUSE_SERVER || 'localhost',
    port: process.env.CLICKHOUSE_PORT || 8123,
    queryOptions: { database: process.env.CLICKHOUSE_DB || 'hepic_statistics' }
};

var clickhouse = new ClickHouse(clickhouse_options);

var createTable = function(tableName){
	if (!tableName) return;
	var query = "CREATE TABLE IF NOT EXISTS "+tableName+" (entity String, ts UInt64, m Array(String), mv Array(Float32), t Array(String), tv Array(String), d Date MATERIALIZED toDate(round(ts/"+tsDivide+")), dt DateTime MATERIALIZED toDateTime(round(ts/"+tsDivide+")) ) ENGINE = MergeTree(d, entity, 8192)";
	return query;
};

var tables = [];
var getTables = function(){
	var showTables = "show tables";
	var stream = clickhouse.query(showTables);
	stream.on ('data', function (row) {
	  if (tables.indexOf(row[0]) === -1) tables.push (row[0]);
	});
	stream.on ('error', function (err) {
		// TODO: handler error
		console.log('GET TABLES ERR',err);
		return false;
	});
	stream.on ('end', function () {
		if (debug) console.log('RELOAD TABLES:',tables);
		return tables;
	});
}
getTables();

var express = require('express')
  , http = require('http')
  , path = require('path')
  , util = require('util');

var app = express();

function rawBody(req, res, next) {
  req.setEncoding('utf8');
  req.rawBody = '';
  req.on('data', function(chunk) {
    req.rawBody += chunk;
  });
  req.on('end', function(){
    next();
  });
}

app.set('port', process.env.PORT || 8686);
app.use(rawBody);

app.post('/write', function(req, res) {
  if (debug) console.log('RAW: ' , req.rawBody);
  if (debug) console.log('QUERY: ', req.query);

  // Use DB from Query, if any
  if (req.query.db) {
	if (debug) console.log('DB',req.query.db )
	clickhouse_options.queryOptions.database = req.query.db;
  	// Re-Initialize Clickhouse Client
  	clickhouse = new ClickHouse(clickhouse_options);
  }

  var queries = req.rawBody.split("\n");
  queries.forEach(function(rawBody){
	  if (!rawBody || rawBody == '') return;
	  var query = clickline(rawBody);
	  if (query.parsed.measurement) table = query.parsed.measurement;
	  if (tables.indexOf(table) === -1) { 
		  console.log('Creating new table...',table)
		  try {
			clickhouse.querying(createTable(table))
				.then((result) => sendQuery(query.query,false,true) )
			getTables();
		  } catch(e) { console.log(e) }
	  } else {
		  sendQuery(query.query);
	  }
  });
  res.sendStatus(200);
});

http.createServer(app).listen(app.get('port'), function(){
  console.log("ClickFlux server listening on port " + app.get('port'));
});

var sendQuery = async function(query,res,update){
  if (query.includes('undefined')) return;
  if (debug) console.log('SHIPPING QUERY...',query,res,update);
  clickhouse.query(query, {syncParser: true}, function (err, data) {
        if (err) {
                console.log('QUERY ERR',err.toString(),query);
		var parsed = err.toString().match(/Table\s(.*) doesn/g);
               	if (parsed && parsed[1]){
               	 console.log('Create Table and retry!',parsed);
                 try {
                       clickhouse.querying(createTable(parsed[1])).then((result) => sendQuery(query.query,res,true) )
                       if(res) res.sendStatus(200);
                 } catch(e) { if (res) res.sendStatus(500) }
               	} else {
			return;
		}
        } else {
                if (debug) console.log(data);
                if (res) res.sendStatus(200);
        }
	if (update) getTables();
  });
};

var databases = [];
app.all('/query', function(req, res) {
  console.log('QUERY:', req.query.q, req.rawBody);
  var rawQuery;
  try {
	  if(req.query.q) { rawQuery = req.query.q; }
          else if(req.rawBody) { rawQuery =  unescape( req.rawBody.replace(/^q=/,'').replace(/\+/g,' ') ); }

          if (rawQuery.startsWith('CREATE DATABASE')) {
		  res.sendStatus(200);

          } else if (rawQuery.startsWith('SHOW RETENTION')) {
		var data = { "results": [] };
		databases.forEach(function(db,i){
	  	    data.results.push({
		      "statement_id": i,
		      "series": [
		        {
		          "columns": [
		            "name",
		            "duration",
		            "shardGroupDuration",
		            "replicaN",
		            "default"
		          ],
		          "values": [
		            [
		              "autogen",
		              "0s",
		              "168h0m0s",
		              1,
		              true
		            ]
		          ]
		        }
		      ]
		    });
			
		});
		res.send(data);

          } else if (rawQuery.startsWith('SHOW MEASUREMENTS')) {
		databases.forEach(function(db){
			
		});
		res.send(results);

          } else if (rawQuery.startsWith('SHOW DATABASES')) {
		var response = [];
		var stream = clickhouse.query(rawQuery);
		stream.on ('data', function (row) {
		  response.push (row);
		});
		stream.on ('error', function (err) {
			// TODO: handler error
			console.log('GET DATA ERR',err);
		});
		stream.on ('end', function () {
			databases = response;
			var results = {"results":[{"statement_id":0,"series":[{"name":"databases","columns":["name"], "values": response } ]} ]};
			console.log(JSON.stringify(results));
			res.send(results);
		});

          } else {
                var parsed = ifqlparser.parse(rawQuery);
                res.send(parsed);
          }
  } catch(e) {
          console.log(e);
	  getTables();
          res.sendStatus(500);
  }
	
});

/* INFLUXDB PING EMULATION */
app.get('/ping', (req, res) => {
	if (debug) console.log('PING req', req);
	clickhouse.pinging().then((result) => { res.sendStatus(204) } )
})

process.on('unhandledRejection', function(err, promise) {
    console.error('Unhandled rejection (promise: ', promise, ', reason: ', err, ').');
});
