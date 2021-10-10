import ws from "k6/ws";
import http from "k6/http"
import encoding from 'k6/encoding';
import { group, check, sleep } from "k6";
import { Rate, Trend } from 'k6/metrics';

const http_api_host='xxxxxxxxxx.appsync-api.cn-northwest-1.amazonaws.com.cn';
const realtime_api_host='xxxxxxxxxx.appsync-realtime-api.cn-northwest-1.amazonaws.com.cn'

const cname_http_api_host='graphql.example.com';
const cname_realtime_api_host='rt.example.com'


const authz = {
  host: http_api_host,
  'x-api-key': 'da2-your-api-key'
};

const header = encoding.b64encode(JSON.stringify(authz));

const REALTIME_ENDPOINT = `wss://${cname_realtime_api_host}:443/graphql?header=${header}&payload=e30=`;
const HTTP_ENDPOINT     = `https://${cname_http_api_host}/graphql`;

//console.log(REALTIME_ENDPOINT)

let ramp_up_duration   = 20,  // 在x秒内建立 *target* 个ws连接
    keepalive_duration = 2,   // 保持x秒ws连接不断开
    tear_down_duration = 10,   // tear down
    target             = 10 // 建立连接数
    ;

let subscription_data = {
  "id": null, // need to update before sending
  "payload":{
    "data":"{\"query\":\"subscription MySubscription { onCreateRoom { __typename id title } }\",\"variables\":null}",
    "extensions":{
      "authorization": authz
    }
  },
  "type":"start"
}

let ws_resp_delay = new Trend('ws_resp_delay(ms)');

// 统计ws响应请求的成功率
export let ResponseSuccessRate = new Rate('ResponseSuccessRate');

export let options = {
  scenarios: {
    'appsync-listener': {  // 建立ws连接
      executor: 'ramping-vus',
      exec: 'listener', // defaults to "default"
      startVUs: 0,
      stages: [
        { duration: ramp_up_duration   + 's', target: target },
        { duration: keepalive_duration + 's', target: target },
        { duration: tear_down_duration + 's', target: 0 },
      ],
      gracefulRampDown: '3s',
      gracefulStop: '3s',
    },
    'appsync-broadcast': { //
      executor: 'per-vu-iterations',
      exec: 'broadcast',
      vus: 1,
      iterations: 1,
      startTime: (ramp_up_duration + Math.floor(keepalive_duration * Math.random())) + 's',
      maxDuration: '5s',
    }
  },
  thresholds: {
    ResponseSuccessRate: [
      'rate>0.90', // should be great than 90%
      { threshold: "rate>0.85", abortOnFail: true }, // stop early if less than 85%
    ]
  },
};

// 建立ws连接的主函数
export function listener() {
  const url = REALTIME_ENDPOINT;
  const params = { headers:{"Sec-WebSocket-Protocol": "graphql-ws"}, tags: { my_tag: "hello" } };

  const response = ws.connect(url, params, function(socket) {
    socket.on("open", function open() {
      // console.log("connected");
      socket.send('{ "type": "connection_init" }');
    });

    socket.on("message", (msg) => {
      on_message(msg, socket)
    });

    socket.on("close", () => console.log("disconnected"));

    socket.on("error", on_error);
  });

  check(response, { "status is 101": r => r && r.status === 101 });
}

// 发送广播消息的函数
export function broadcast() {
  const url = HTTP_ENDPOINT;
  let headers = {
    "Content-Type": "application/json",
    "x-api-key": authz["x-api-key"]
  };
  let data = {
    "query": `mutation MyMutation { createRoom(input: {title: "room-${+new Date()}"}) { id, title  } }`,
    "variables": null,
    "operationName": "MyMutation"
  }

  console.log(url, JSON.stringify(data), {headers: headers})

  let res = http.post(url, JSON.stringify(data), {headers: headers});
  // console.log('broadcast resp: ' + res.body);
}

function on_message(msg, socket) {
  var _msg = JSON.parse(msg);
//  console.log("ws resp: " + msg)

  switch(_msg.type) {
    case 'ka': // keep alive
    case 'start_ack': break;

    case 'error':
      ResponseSuccessRate.add(0);
      console.error(JSON.stringify(_msg.payload.errors));
      return;
    case 'connection_ack':
      subscription_data.id = `user-${__VU}`;
      socket.send(JSON.stringify(subscription_data));
      break;
    case 'data':
      // receive broadcast
      // {"id":"user-1","type":"data","payload":{"data":{"onCreateRoom":{"__typename":"Room","id":"xx","title":"room-1601101219641"}}}}
      let received_at = +new Date();
      let created_at = _msg.payload.data.onCreateRoom.title.split('-')[1];
      let duration = received_at - created_at; // ms
      // console.log(duration);

      ws_resp_delay.add(duration);
      break;
    default:
      console.warn(`unknown msg type: ${JSON.stringify(_msg)}`)
  }
  ResponseSuccessRate.add(1);
}

function on_error(e) {
  if (e.error() != "websocket: close sent") {
    ResponseSuccessRate.add(0);
    console.log("An unexpected error occured: ", e.error());
  }
}